#!/usr/bin/env node
/**
 * DevSpec provenance assistance for Claude Code — ADR 71c23b46.
 *
 * WHAT THIS IS NOT, because it replaces something that was:
 *
 * The predecessor (`claim-guard.mjs`) tried to decide, from a command string,
 * whether an action was "product mutation" and denied when it could not tell. That
 * object of enforcement is undecidable, so it grew a shell tokenizer, a read-only
 * allowlist, redirect classification, path rules, repository authority keys and
 * subagent exceptions — and still blocked reads, tests, typechecks, `git fetch`,
 * worktrees, cross-repository work and post-implementation follow-through. Denials
 * on uncertainty were the defect, not the missing allowlist entries.
 *
 * This module enforces on the ONE artifact that is decidable: a commit message
 * either carries a well-formed DevSpec item reference or it does not.
 *
 * The contract, in one line: **block only on certainty, and only when the agent can
 * recover unaided; allow everything else.** Concretely —
 *
 *  - Edits and execution are NEVER denied for want of a claim. No allowlist, no
 *    tokenizer over arbitrary commands, no path rules. Nothing to bypass, because
 *    nothing is blocked.
 *  - A commit is inspected only when it arrives in a shape this can read with
 *    certainty (see `simpleGitCommit`). Anything else — aliases, compound shell,
 *    `--amend`, `-F`, expansions, GUI commits, merge/rebase/cherry-pick — is allowed
 *    untouched. That is a deliberate hole: the analyzer reconciles it server-side.
 *  - The test is a well-formed REFERENCE, not a live claim. A link stays a link after
 *    `record_implementation` releases the claim, across repositories, and on
 *    follow-up work.
 *  - A reference that IS present is confirmed against the server, because shape alone
 *    cannot tell a real id from a plausible one. That is the only network call this
 *    hook makes, it is bounded, and only a definitive "no such item" denies — every
 *    other answer, and every failure to get one, allows.
 *  - Where exactly one claim is unambiguously active, the reference is APPENDED for
 *    the agent (`hookSpecificOutput.updatedInput`) and reported, rather than refused.
 *  - Offline, server error, ambiguous claim set, uncertain jurisdiction: allow.
 *
 * This is cooperative provenance, not a security boundary — a plugin can be removed,
 * a GUI used, another agent used. It never weakens Claude's own permissions, and it
 * is not the mechanism protecting anything else (auth, cost, destructive SQL,
 * deployment safety and host sandboxing are independent and untouched).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { devspecFolderMarker, gitRemoteOrigin } from './devspec-scope.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { hostTokenFromEnv, resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

export const CONTRACT_URI = 'devspec://product/implementation-contract'
export const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Ceiling on the single network call, deliberately a small fraction of the hook's own
 * 10s budget. A commit waiting on a slow server is a commit the agent experiences as a
 * hang, and no answer is not an answer: past this, the reference is unconfirmed and the
 * commit proceeds.
 */
export const ONLINE_TIMEOUT_MS = 2_500
const FUTURE_SKEW_MS = 5 * 60 * 1000
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const UUID_RE = new RegExp(`^${UUID}$`, 'i')

/**
 * A DevSpec reference in a commit message. The FULL uuid is required, not the short
 * code: a message carrying a correct short code with a wrong uuid suffix reads as
 * linked to a human and links to nothing, which is a real failure that has already
 * reached shared history once.
 */
const REFERENCE_RE = new RegExp(`\\[devspec:(${UUID})\\]`, 'i')

const CLAIM_TOOL = 'mcp__devspec__claim_work_item'
const RELEASE_TOOLS = new Set([
  'mcp__devspec__record_implementation',
  'mcp__devspec__fail_work_item',
  'mcp__devspec__release_work_item',
])

/** Tools this hook is registered for. Edits are observed; only Bash can be denied. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

export function stateDir(env = process.env) {
  if (env.DEVSPEC_CLAUDE_STATE_DIR) return env.DEVSPEC_CLAUDE_STATE_DIR
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return path.join(os.tmpdir(), `devspec-claude-provenance-${uid}`)
}

/**
 * POSIX modes are a real control on Linux/macOS and a synthesised fiction on Windows,
 * where Node reports 0o777 for directories and chmod only toggles read-only. Set them
 * everywhere as best effort; assert them only where the platform can express them.
 * Asserting unconditionally once denied all mutation on Windows for ever
 * (devspec:730bf485) — and now that nothing is denied, a state failure must degrade to
 * "no stamping", never to a block.
 */
function enforcesPosixModes(platform) {
  return platform !== 'win32'
}

function restrictMode(target, mode, platform) {
  try {
    fs.chmodSync(target, mode)
  } catch (error) {
    if (enforcesPosixModes(platform)) throw error
  }
}

function ensurePrivateDirectory(dir, platform = process.platform) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('provenance state path is not a directory')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('provenance state directory is not owned by this user')
  }
  restrictMode(dir, 0o700, platform)
}

function atomicWritePrivate(file, value, platform = process.platform) {
  ensurePrivateDirectory(path.dirname(file), platform)
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, file)
    restrictMode(file, 0o600, platform)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch { /* renamed, or never created */ }
  }
}

/** `--git-common-dir` is one identity for a repository and all of its worktrees. */
function canonicalCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) throw new Error('missing hook cwd')
  return fs.realpathSync(cwd)
}

function canonicalRepo(cwdPath) {
  try {
    const repository = execFileSync(
      'git',
      ['-C', cwdPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    ).trim()
    return fs.realpathSync(repository)
  } catch {
    return cwdPath
  }
}

/** `<main>/.git` → `<main>`; null for a bare repo or a non-repository directory. */
function mainWorktreeOf(repoRoot) {
  return path.basename(repoRoot) === '.git' ? path.dirname(repoRoot) : null
}

function validSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(value)
}

function scopeFrom(input) {
  if (!input || typeof input !== 'object' || !validSessionId(input.session_id)) {
    throw new Error('missing or malformed hook session_id')
  }
  const cwd = canonicalCwd(input.cwd)
  const repoRoot = canonicalRepo(cwd)
  return { sessionId: input.session_id, cwd, repoRoot, mainWorktree: mainWorktreeOf(repoRoot) }
}

function statePathFor(scope, kind, env = process.env) {
  const digest = crypto
    .createHash('sha256')
    .update(`${scope.sessionId}\0${scope.repoRoot}`)
    .digest('hex')
  return path.join(stateDir(env), `${digest}.${kind}.json`)
}

/**
 * Claims this session holds in this repository.
 *
 * A SET, not a single value, because the ADR forbids guessing which of several
 * claims a commit belongs to. One claim means stamping is safe; two mean it is not.
 */
export function readClaims(scope, { env = process.env, now = Date.now(), platform = process.platform } = {}) {
  const file = statePathFor(scope, 'claims', env)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return []
    if (enforcesPosixModes(platform) && (stat.mode & 0o077) !== 0) return []
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed?.schema !== 1 || !Array.isArray(parsed.claims)) return []
    if (typeof parsed.updated_at !== 'number') return []
    if (parsed.updated_at > now + FUTURE_SKEW_MS) return []
    if (now - parsed.updated_at > CLAIM_MAX_AGE_MS) return []
    if (parsed.session_id !== scope.sessionId || parsed.repo_root !== scope.repoRoot) return []
    return parsed.claims.filter((id) => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase())
  } catch {
    return []
  }
}

function writeClaims(scope, claims, { env = process.env, now = Date.now(), platform = process.platform } = {}) {
  const file = statePathFor(scope, 'claims', env)
  if (claims.length === 0) {
    try { fs.unlinkSync(file) } catch { /* nothing to remove */ }
    return
  }
  atomicWritePrivate(file, {
    schema: 1,
    session_id: scope.sessionId,
    repo_root: scope.repoRoot,
    claims: [...new Set(claims.map((id) => id.toLowerCase()))],
    updated_at: now,
  }, platform)
}

/* ------------------------------------------------------------------ *
 * Reading a commit message out of a Bash command, without pretending  *
 * ------------------------------------------------------------------ */

/**
 * Recognise ONLY the simple, unambiguous `git commit … -m <message> …` form, and
 * return where its message text sits so it can be read and (optionally) appended to.
 *
 * This is a MATCHER, not the classifier this module replaced, and the difference is
 * the direction it fails. The old code asked "is this arbitrary command a mutation?"
 * and denied when unsure. This asks "is this exactly the shape I can read with
 * certainty?" and allows when unsure. Every `return null` below is an ALLOW.
 *
 * Refused outright (→ allowed, reconciled by the analyzer instead): anything with
 * shell structure or expansion, any path-qualified or aliased git, message sources
 * this cannot see (`-F`, `--file`, `--reuse-message`, `-c`, `-C`, `--template`), and
 * history-rewriting or message-inheriting forms (`--amend`, `--squash`, `--fixup`,
 * `--no-edit`) where appending text would be unsafe or would edit a message that is
 * not this commit's.
 */
export function simpleGitCommit(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192) return null

  const segments = [[]]
  let word = ''
  let started = false
  let quote = null
  let wordStart = -1

  const endWord = (at) => {
    if (!started) return
    segments[segments.length - 1].push({ value: word, start: wordStart, end: at })
    word = ''
    started = false
    wordStart = -1
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (quote === "'") {
      // Single quotes: everything is literal, including $ and backtick.
      if (char === "'") { quote = null; continue }
      word += char
      started = true
      continue
    }
    if (quote === '"') {
      if (char === '"') { quote = null; continue }
      // Inside double quotes these still expand, and a backslash shifts offsets.
      if (char === '$' || char === '`' || char === '\\') return null
      word += char
      started = true
      continue
    }

    if (char === '"' || char === "'") {
      if (!started) wordStart = index
      quote = char
      started = true
      continue
    }
    // `&&` is the one separator this reads, and only for the `cd … && git commit`
    // shape checked below. A lone `&` (background) still refuses.
    if (char === '&') {
      if (command[index + 1] !== '&') return null
      if (segments.length > 1) return null // at most one separator
      endWord(index)
      segments.push([])
      index += 1
      continue
    }
    // Unquoted shell structure or expansion: not a shape this can read honestly.
    // Refused only OUTSIDE quotes — a commit message may legitimately contain braces,
    // parentheses or a semicolon, and refusing those would hand every ordinary message
    // to the analyzer for no reason.
    if ('|;<>(){}`$\\\n\r'.includes(char)) return null
    if (/\s/.test(char)) {
      endWord(index)
      continue
    }
    if (!started) wordStart = index
    word += char
    started = true
  }
  if (quote) return null
  endWord(command.length)

  /**
   * Which segment carries the commit.
   *
   * The isolated-worktree workflow the implementation contract requires cannot be
   * expressed as a bare `git commit`: Claude resets the shell cwd on every call, so
   * reaching a worktree needs `cd <path> &&` or `git -C <path>`. Refusing both left
   * the check unable to read the only commits real agent work produces — teeth that
   * looked mechanical and never fired (devspec:e21d7d4b, follow-up).
   *
   * Both are safe to read past, and for the same reason: neither can author a commit
   * nor change which verb runs. `cd` only moves; `-C` only names a directory and takes
   * exactly one value, so the verb's position stays known. Anything else before the
   * verb, a second separator, or a first segment that is not exactly `cd <one-path>`
   * still refuses — and refusing still means allow.
   */
  if (segments.length === 2) {
    const prefix = segments[0]
    if (prefix.length !== 2 || prefix[0].value !== 'cd') return null
    if (prefix[1].value.startsWith('-')) return null
  }
  const words = segments[segments.length - 1]

  if (words.length === 0) return null
  if (words[0].value !== 'git') return null

  let index = 1
  while (index < words.length && words[index].value.startsWith('-')) {
    const option = words[index].value
    if (option === '-C') {
      if (!words[index + 1] || words[index + 1].value.startsWith('-')) return null
      index += 2
      continue
    }
    if (option === '--no-pager' || option === '--no-optional-locks') {
      index += 1
      continue
    }
    // Any other global option may take a value and shift the verb. Refuse.
    return null
  }
  if (words[index]?.value !== 'commit') return null

  const rest = words.slice(index + 1)
  const REFUSED = new Set([
    '--amend', '--squash', '--fixup', '--no-edit', '--template', '-t',
    '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message',
    '--interactive', '-i', '-p', '--patch',
  ])
  for (const entry of rest) {
    if (REFUSED.has(entry.value)) return null
    if (/^(?:--file|--template|--reuse-message|--reedit-message|--squash|--fixup)=/.test(entry.value)) return null
  }

  // Exactly one readable message argument, or this is not the simple form.
  const messages = []
  for (let i = 0; i < rest.length; i += 1) {
    const entry = rest[i]
    if (entry.value === '-m' || entry.value === '--message') {
      const next = rest[i + 1]
      if (!next) return null
      messages.push(next)
      i += 1
      continue
    }
    if (entry.value.startsWith('--message=')) {
      messages.push({ value: entry.value.slice('--message='.length), start: entry.start, end: entry.end, joined: true })
      continue
    }
    if (/^-m./.test(entry.value)) {
      messages.push({ value: entry.value.slice(2), start: entry.start, end: entry.end, joined: true })
      continue
    }
  }
  if (messages.length !== 1) return null

  const message = messages[0]
  // Appending is safe ONLY into a quoted message, where the text can go immediately
  // before the closing quote. A bare unquoted word cannot take one: ` [devspec:…]`
  // would become a separate argument (git would read it as a pathspec), so those are
  // reported unappendable and fall through to the recovery path instead.
  const closing = command[message.end - 1]
  const quoted = closing === '"' || closing === "'"
  return {
    message: message.value,
    insertOffset: message.end - 1,
    appendable: quoted,
  }
}

/** A heredoc delimiter this will read: a plain word, so it cannot hide structure. */
const HEREDOC_DELIMITER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The two multi-line message forms this can read with the same certainty as a quoted
 * `-m` — and the reason the certainty holds.
 *
 * `simpleGitCommit` refuses every `<<`, `$` and newline, because in general they mean
 * structure or expansion it cannot evaluate. That is right in general and wrong for
 * the two shapes below, which is why almost nothing reached the check: a commit
 * message with a BODY cannot be written as one quoted `-m` argument, so every commit
 * that carried real prose took the refusal path. Measured on one repository's staging
 * branch over 14 days: 343 non-merge commits, 59 with no reference, and all 59 of them
 * multi-line (item 022e487b).
 *
 * What makes these two decidable is the SINGLE-QUOTED heredoc. Inside `<<'D' … D` the
 * shell performs no expansion at all — no parameters, no substitution, no escapes — so
 * the message is exactly the bytes between the delimiter lines. Nothing is guessed:
 *
 *   git commit -F - <<'MSG'          git commit -m "$(cat <<'MSG'
 *   subject                          subject
 *                                    MSG
 *   body                             )"
 *   MSG
 *
 * Everything else still refuses, and refusing still means allow: an UNQUOTED
 * delimiter (expansion applies), `<<-`, a second heredoc, a substitution that is not
 * exactly `cat` of one heredoc, a backtick, or any trailing text this did not expect.
 *
 * `-F <path>` is deliberately NOT read, even though a file is also legible. Two
 * reasons: the only outcome available would be a denial, since a reference cannot be
 * stamped into someone else's file by rewriting a command; and the file may well be
 * written by the very compound command being inspected, so reading it at PreToolUse
 * time can be wrong in a way the inline forms above never are.
 *
 * Validation reuses `simpleGitCommit` rather than reimplementing it: the head is
 * normalised into the equivalent simple form (`-F -` or `-m "$(cat` becomes a literal
 * `-m "x"`) and handed to the existing reader, so every rule about prefixes, global
 * options, refused flags and duplicate messages applies here unchanged and cannot
 * drift away from it.
 */
export function heredocGitCommit(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192) return null
  if (command.includes('`')) return null

  // Exactly one single-quoted heredoc, and no other heredoc of any kind.
  const open = command.indexOf("<<'")
  if (open === -1) return null
  if (command.indexOf('<<', open + 3) !== -1) return null
  if (command.indexOf('<<', 0) !== open) return null

  const delimEnd = command.indexOf("'", open + 3)
  if (delimEnd === -1) return null
  const delimiter = command.slice(open + 3, delimEnd)
  if (!HEREDOC_DELIMITER.test(delimiter)) return null

  // The body starts on the next line, so the delimiter must end its own line.
  let cursor = delimEnd + 1
  if (command[cursor] === '\r') cursor += 1
  if (command[cursor] !== '\n') return null
  const bodyStart = cursor + 1

  // The terminator is a line containing exactly the delimiter.
  const terminator = `\n${delimiter}`
  let close = command.indexOf(terminator, bodyStart - 1)
  while (close !== -1) {
    const after = command[close + terminator.length]
    if (after === undefined || after === '\n' || after === '\r') break
    close = command.indexOf(terminator, close + 1)
  }
  if (close === -1 || close < bodyStart - 1) return null

  const body = command.slice(bodyStart, close)
  const head = command.slice(0, open)
  const tail = command.slice(close + terminator.length)
  if (head.includes('\n') || head.includes('\r')) return null

  // Which form is this, and what does the head look like without the heredoc?
  let normalised = null
  const viaStdin = /^(?<pre>.*?)\s(?:-F|--file)\s+-\s*$/.exec(head)
  const viaSubstitution = /^(?<pre>.*?)\s-m\s+"\$\(cat\s*$/.exec(head)

  if (viaStdin) {
    // `-F -` reads the message from stdin, which is the heredoc: nothing else may follow.
    if (tail.trim() !== '') return null
    if (head.includes('$')) return null
    normalised = `${viaStdin.groups.pre} -m "x"`
  } else if (viaSubstitution) {
    // The substitution must close immediately after the delimiter line, and be the only one.
    if (tail.trim() !== ')"') return null
    if (command.indexOf('$(') !== command.lastIndexOf('$(')) return null
    if (viaSubstitution.groups.pre.includes('$')) return null
    normalised = `${viaSubstitution.groups.pre} -m "x"`
  } else {
    return null
  }

  // Every prefix, global-option, refused-flag and duplicate-message rule comes from
  // the existing reader, applied to the equivalent simple command.
  const simple = simpleGitCommit(normalised)
  if (!simple || simple.message !== 'x') return null

  // Append to the SUBJECT line, inside the heredoc. Appending after the terminator
  // would land outside the message; appending to the last body line would corrupt a
  // trailer (`Co-Authored-By:` is routinely last).
  const firstBreak = body.indexOf('\n')
  const subjectEnd = firstBreak === -1 ? bodyStart + body.length : bodyStart + firstBreak

  return { message: body, insertOffset: subjectEnd, appendable: true }
}

/** A push this can reason about at all. Everything else is allowed untouched. */
export function isSimpleGitPush(command) {
  if (typeof command !== 'string' || /[|&;<>(){}`$\n\r]/.test(command)) return false
  const words = command.trim().split(/\s+/)
  return words[0] === 'git' && words[1] === 'push'
}

export function referenceIn(message) {
  const match = typeof message === 'string' ? message.match(REFERENCE_RE) : null
  return match ? match[1].toLowerCase() : null
}

/**
 * Does this reference resolve to a real item in the project this folder belongs to?
 *
 * Shape is not existence. A reference can be perfectly well formed and point at
 * nothing — a correct short code with a wrong uuid tail is the shape of the failure,
 * and it reached shared `staging` during this very programme, caught only afterwards by
 * the authoritative link `record_implementation` wrote. Asking the server moves that
 * catch to the moment the commit is made, which is the only moment it is still free to
 * fix.
 *
 * Returns one of the four outcomes named by the product contract
 * (`commit_provenance_contract.validation.online_outcomes`). Only `not_found` is
 * definitive. `unavailable` and `indeterminate` both mean "no answer" and must never be
 * collapsed into it — so every way this can fail (no token, no endpoint, DNS, TCP, TLS,
 * an HTTP error, an MCP error, a project that could not be resolved, the timeout, a body
 * we cannot parse) lands there and allows.
 *
 * Credentials and the endpoint are resolved from `env` and the folder's own MCP
 * configuration, never from a value this module holds.
 */
export async function confirmReferenceOnline(commitMessage, options = {}) {
  const {
    cwd,
    mainWorktree = null,
    marker = null,
    env = process.env,
    timeoutMs = ONLINE_TIMEOUT_MS,
    call = mcpToolsCall,
  } = options

  const auth = resolveAuth(cwd, mainWorktree, env)
  if (!auth) return 'unavailable'

  // Jurisdiction hints, so the server answers for the project this folder belongs to
  // instead of guessing from an account-wide token. Both are best-effort: without them
  // an unresolvable project is an error, which is an allow.
  const args = { commit_message: commitMessage }
  if (marker?.kind === 'pin' && typeof marker.project_id === 'string' && marker.project_id) {
    args.pinned_project_id = marker.project_id
  }
  const remote = gitRemoteOrigin(cwd)
  if (remote) args.git_remote = remote

  let result
  try {
    result = await call({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'validate_commit_reference',
      arguments: args,
      timeoutMs,
    })
  } catch {
    return 'unavailable'
  }

  const status = result?.online?.status
  if (status === 'not_found') return 'not_found'
  if (status === 'valid') return 'valid'
  return 'indeterminate'
}

/* ---------- *
 * Decisions  *
 * ---------- */

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

function stamp(updatedCommand, toolInput, itemId) {
  return {
    systemMessage: `DevSpec stamped [devspec:${itemId}] onto this commit message (one active claim).`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...toolInput, command: updatedCommand },
    },
  }
}

/**
 * A reminder has to reach the party that can act on it. `systemMessage` renders in the
 * terminal, which is the human's channel — and on this project a great deal of work is
 * driven from a phone, where no terminal is ever seen. The agent reads
 * `additionalContext`. Emitting both means the reminder lands with whoever is there.
 */
function nudge(message) {
  return {
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: message,
    },
  }
}

/**
 * How a denial reads matters as much as when it fires: the work is already written by
 * the time a commit is refused, so the message must be a complete recipe the agent can
 * follow alone. It never terminates the turn and never demands a full criteria set —
 * a thin last-mile item is a legitimate answer.
 */
function recoveryText(claims) {
  if (claims.length > 1) {
    return [
      `DevSpec: this commit has no [devspec:<id>] reference and ${claims.length} claims are active, so nothing was added automatically.`,
      `Pick the one this commit belongs to and put it in the message: ${claims.map((id) => `[devspec:${id}]`).join(' or ')}`,
      'Then retry the commit. Nothing else is blocked.',
    ].join(' ')
  }
  return [
    'DevSpec: this commit has no [devspec:<id>] reference, so it would land unlinked.',
    'Recover without leaving this turn: reuse or create the smallest item that covers it',
    '(search_action_items, or create_action_item with a one-line description — a thin',
    'last-mile item is fine), then add [devspec:<full-uuid>] to the commit message and retry.',
    `Authority: ${CONTRACT_URI}. Nothing else is blocked, and no other command is affected.`,
  ].join(' ')
}

/**
 * Credentials for the one call, from the cwd chain and then from the repository's main
 * working tree.
 *
 * The second place is not a nicety. `.mcp.json` and `.claude/settings.local.json` are
 * normally untracked, so a linked worktree carries neither — and the implementation
 * contract *requires* work to happen in one. Looking only at the cwd would leave this
 * check silently inert for exactly the workflow it exists to protect, which is the same
 * mistake 0.16.0 made about the commit shape. Jurisdiction already consults the main
 * worktree for the same reason (`devspecFolderMarker`).
 */
function resolveAuth(cwd, mainWorktree, env) {
  const hostToken = hostTokenFromEnv(env)
  for (const dir of [cwd, mainWorktree]) {
    if (!dir) continue
    try {
      const auth = resolveDevspecMcpAuth(dir, { env, hostToken })
      if (auth?.ok && auth.token && auth.mcp_url) return auth
    } catch {
      /* an unreadable config is simply not a source of credentials */
    }
  }
  return null
}

/**
 * A reference that resolves to nothing. The commit is refused, the turn is not, and the
 * message names the cause that actually produces this: the reference is well formed, so
 * the mistake is in its VALUE, not its syntax.
 */
function unresolvedReferenceText(reference) {
  return [
    `DevSpec: [devspec:${reference}] is well formed but resolves to no item in this project,`,
    'so this commit would read as linked and link to nothing.',
    'That is usually a correct short code with a wrong uuid tail, or an item belonging to a different project.',
    'Recover without leaving this turn: confirm the id (get_action_item, or search_action_items),',
    'correct the reference in the commit message and retry.',
    `Authority: ${CONTRACT_URI}. Nothing else is blocked, and no other command is affected.`,
  ].join(' ')
}

export function handleSessionStart() {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `DevSpec implementation contract: ${CONTRACT_URI}`,
    },
  }
}

export function handlePost(input, options = {}) {
  const { env = process.env, now = Date.now(), platform = process.platform } = options
  const tool = input?.tool_name ?? input?.toolName
  if (tool !== CLAIM_TOOL && !RELEASE_TOOLS.has(tool)) return null
  let scope
  try { scope = scopeFrom(input) } catch { return null }

  const itemId = claimedItemIdFrom(input)
  if (!itemId) return null
  const current = readClaims(scope, { env, now, platform })
  try {
    if (tool === CLAIM_TOOL) {
      writeClaims(scope, [...current, itemId], { env, now, platform })
    } else {
      writeClaims(scope, current.filter((id) => id !== itemId), { env, now, platform })
    }
  } catch {
    // State is an optimisation for stamping only. Losing it costs a convenience,
    // never a block, so a failure here is deliberately silent.
  }
  return null
}

/** The item id a successful DevSpec result actually carried. Never prompt text. */
function claimedItemIdFrom(input) {
  const response = input?.tool_response ?? input?.toolResponse
  const texts = []
  const collect = (value) => {
    if (typeof value === 'string') { texts.push(value); return }
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string') texts.push(value.text)
      for (const nested of Object.values(value)) if (nested && typeof nested === 'object') collect(nested)
    }
  }
  collect(response)
  const requested = input?.tool_input?.action_item_id
  for (const text of texts) {
    let parsed
    try { parsed = JSON.parse(text) } catch { continue }
    const values = Array.isArray(parsed) ? parsed : [parsed]
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      if (value.error || value.success === false || value.ok === false) continue
      const id = typeof value.id === 'string' ? value.id : null
      if (id && UUID_RE.test(id)) return id.toLowerCase()
    }
  }
  // A response we could not parse must not invent a claim; fall back only to an
  // explicitly requested well-formed id when the response carried no error text.
  if (UUID_RE.test(requested || '') && !texts.some((t) => /"error"|not found|failed/i.test(t))) {
    return requested.toLowerCase()
  }
  return null
}

export async function handlePre(input, options = {}) {
  const { env = process.env, now = Date.now(), platform = process.platform } = options
  const tool = input?.tool_name ?? input?.toolName
  if (tool !== 'Bash' && !EDIT_TOOLS.has(tool)) return null

  let scope
  try { scope = scopeFrom(input) } catch { return null }

  // Jurisdiction is positive and local: without a marker this folder is not ours.
  // Uncertain jurisdiction allows, so a throwing marker lookup is an allow too.
  let marker = null
  try {
    marker = devspecFolderMarker(scope.cwd, {
      home: env.USERPROFILE || env.HOME || os.homedir(),
      mainWorktree: scope.mainWorktree,
    })
  } catch { return null }
  if (!marker) return null

  const claims = readClaims(scope, { env, now, platform })

  // Edits are never denied. At most one reminder per session+repository.
  if (EDIT_TOOLS.has(tool)) {
    if (claims.length > 0) return null
    return maybeNudge(scope, { env, now, platform })
  }

  const command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (!command) return null

  const commit = simpleGitCommit(command) ?? heredocGitCommit(command)
  if (!commit) {
    // Not a shape we can read: allowed untouched, by design.
    return null
  }

  const reference = referenceIn(commit.message)
  if (reference) {
    // A well-formed reference is a link, regardless of which claim is held or whether
    // any is: that is what makes follow-up work, cross-repository work and anything
    // after `record_implementation` possible.
    //
    // It is not, however, proof that the item exists — so this is the one place the
    // hook goes to the network, and the only answer that changes anything is a
    // definitive "no such item". Absent a reference the path below stays entirely
    // local, which is why offline work and the unclaimed case never touch it.
    const outcome = await confirmReferenceOnline(commit.message, {
      cwd: scope.cwd,
      mainWorktree: scope.mainWorktree,
      marker,
      env,
      timeoutMs: options.timeoutMs,
      call: options.call,
    })
    if (outcome === 'not_found') return deny(unresolvedReferenceText(reference))
    return null
  }

  if (claims.length === 1 && commit.appendable) {
    const id = claims[0]
    const updated = `${command.slice(0, commit.insertOffset)} [devspec:${id}]${command.slice(commit.insertOffset)}`
    return stamp(updated, input.tool_input, id)
  }

  return deny(recoveryText(claims))
}

function maybeNudge(scope, { env, now, platform }) {
  const file = statePathFor(scope, 'nudged', env)
  try {
    if (fs.existsSync(file)) return null
    atomicWritePrivate(file, { schema: 1, at: now }, platform)
  } catch {
    // Cannot remember having nudged → stay silent rather than repeat every edit.
    return null
  }
  // What this says matters as much as where it lands. It used to promise that an
  // unreferenced commit "will be refused", which is true only of the shapes this can
  // read, and it named the reconciliation that happens afterwards — so it read as a
  // safety net. An agent that believes something will tidy up behind it has less
  // reason to do the right thing now, and the right thing now is cheap: claim, or
  // write one thin item. State that, and nothing else.
  return nudge(
    'DevSpec: no work item is claimed in this repository, so work done here has nothing to trace it to. ' +
    'Claim one before you commit — search_action_items for an existing item, or create_action_item for a ' +
    'thin last-mile one — and put [devspec:<full-uuid>] in the commit message. Editing is never blocked. ' +
    `Shown once per session. Authority: ${CONTRACT_URI}`,
  )
}

function readStdin() {
  return fs.readFileSync(0, 'utf8')
}

function emit(value) {
  if (value !== null && value !== undefined) process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'session-start') return emit(handleSessionStart())
  let input
  try { input = JSON.parse(readStdin()) } catch {
    // Malformed input cannot establish anything, and this gate never blocks on
    // uncertainty. Say nothing and let Claude's own permissions decide.
    return
  }
  if (mode === 'pre') return emit(await handlePre(input))
  if (mode === 'post') return emit(handlePost(input))
  throw new Error('usage: commit-provenance.mjs session-start|pre|post')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    // Fail OPEN, always. A crash in provenance assistance must never stop work.
    if (process.argv[2] === 'pre' || process.argv[2] === 'post') {
      process.stderr.write(`DevSpec provenance hook failed (allowing): ${error.message}\n`)
      process.exitCode = 0
    } else {
      process.stderr.write(`DevSpec provenance hook failed: ${error.message}\n`)
      process.exitCode = 1
    }
  })
}
