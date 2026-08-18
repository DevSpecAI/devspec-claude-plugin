#!/usr/bin/env node
/**
 * Claude Code hooks that make a successful DevSpec claim a mechanical
 * prerequisite for mutation. Claim evidence is derived only from PostToolUse
 * results; prompt text and tool input are never evidence.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CONTRACT_URI = 'devspec://product/implementation-contract'
export const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const FUTURE_SKEW_MS = 5 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CLAIM_TOOL = 'mcp__devspec__claim_work_item'
const TERMINAL_TOOLS = new Set([
  'mcp__devspec__record_implementation',
  'mcp__devspec__fail_work_item',
  'mcp__devspec__release_work_item',
])
const MUTATION_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash'])

function defaultStateDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return path.join(os.tmpdir(), `devspec-claude-claims-${uid}`)
}

export function stateDir(env = process.env) {
  return env.DEVSPEC_CLAUDE_STATE_DIR || defaultStateDir()
}

function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('claim state path is not a directory')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('claim state directory is not owned by this user')
  }
  fs.chmodSync(dir, 0o700)
}

function canonicalRepo(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) throw new Error('missing hook cwd')
  const canonicalCwd = fs.realpathSync(cwd)
  try {
    const root = execFileSync('git', ['-C', canonicalCwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return fs.realpathSync(root)
  } catch {
    return canonicalCwd
  }
}

function validSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(value)
}

function scopeFrom(input) {
  if (!input || typeof input !== 'object' || !validSessionId(input.session_id)) {
    throw new Error('missing or malformed hook session_id')
  }
  return { sessionId: input.session_id, repoRoot: canonicalRepo(input.cwd) }
}

export function evidencePathFor(scope, env = process.env) {
  const digest = crypto
    .createHash('sha256')
    .update(`${scope.sessionId}\0${scope.repoRoot}`)
    .digest('hex')
  return path.join(stateDir(env), `${digest}.json`)
}

function atomicWritePrivate(file, value) {
  ensurePrivateDirectory(path.dirname(file))
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, file)
    fs.chmodSync(file, 0o600)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch { /* rename succeeded or no temp was created */ }
  }
}

function removeEvidence(scope, env = process.env) {
  const file = evidencePathFor(scope, env)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return
    fs.unlinkSync(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export function readEvidence(scope, { env = process.env, now = Date.now() } = {}) {
  const file = evidencePathFor(scope, env)
  try {
    const directory = fs.lstatSync(path.dirname(file))
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) return null
    if (typeof process.getuid === 'function' && directory.uid !== process.getuid()) return null
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null
    if ((stat.mode & 0o077) !== 0) return null
    const evidence = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (
      evidence?.schema !== 1 ||
      evidence.session_id !== scope.sessionId ||
      evidence.repo_root !== scope.repoRoot ||
      !UUID_RE.test(evidence.action_item_id) ||
      !Number.isFinite(evidence.claimed_at) ||
      evidence.claimed_at > now + FUTURE_SKEW_MS ||
      now - evidence.claimed_at > EVIDENCE_MAX_AGE_MS
    ) return null
    return evidence
  } catch {
    return null
  }
}

function responseFrom(input) {
  return input.tool_response ?? input.tool_result ?? input.toolResponse ?? input.toolResult
}

function decodedResponseValues(value, seen = new Set()) {
  if (value === null || value === undefined || seen.has(value)) return []
  if (typeof value === 'string') {
    try { return decodedResponseValues(JSON.parse(value), seen) } catch { return [] }
  }
  if (typeof value !== 'object') return []
  seen.add(value)
  const values = [value]
  if (Array.isArray(value)) {
    for (const item of value) values.push(...decodedResponseValues(item, seen))
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (
        (child && typeof child === 'object') ||
        key === 'text' || key === 'content' || key === 'result' || key === 'data' || key === 'structuredContent'
      ) values.push(...decodedResponseValues(child, seen))
    }
  }
  return values
}

function responseHasError(values) {
  return values.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    if (value.is_error === true || value.isError === true || value.success === false || value.ok === false) return true
    if (Object.hasOwn(value, 'error') && value.error !== null) return true
    return ['error', 'failure', 'conflict', 'possible_conflict', 'not_claimed'].includes(
      String(value.status || value.outcome || '').toLowerCase(),
    )
  })
}

/** The action item one response object is about, or null. */
function itemIdOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  for (const key of ['action_item_id', 'actionItemId', 'item_id', 'itemId', 'id']) {
    if (UUID_RE.test(value[key] || '')) return String(value[key]).toLowerCase()
  }
  for (const key of ['action_item', 'actionItem', 'work_item', 'workItem']) {
    if (UUID_RE.test(value[key]?.id || '')) return String(value[key].id).toLowerCase()
  }
  return null
}

function successfulClaimItemId(response, requestedItemId) {
  if (!UUID_RE.test(requestedItemId || '')) return null
  const requested = requestedItemId.toLowerCase()
  const values = decodedResponseValues(response)
  if (values.length === 0 || responseHasError(values)) return null
  // The server returns the claimed row spread with its own boolean:
  // `{ ...claimed, claim_success: true, work_claim_ref }`. The claim identity is
  // the id ON that object. Requiring exactly one uuid in the whole payload never
  // matched a real response — project_id, parent_action_item_id and every
  // acceptance_criteria[].id are in there too — so no claim was ever observed
  // and the guard blocked every mutation permanently (devspec:4910e673).
  for (const value of values) {
    if (value?.claim_success !== true) continue
    if (itemIdOf(value) === requested) return requested
  }
  return null
}

/**
 * Only `release_work_item` answers with `{ success: true, action_item_id }`.
 * `record_implementation` and `fail_work_item` return the updated row —
 * `{ ...updated, reservation, … }` — with no success flag at all, so demanding
 * one meant evidence was never cleared for two of the three terminal verbs and a
 * finished claim kept authorising mutation until it aged out (devspec:4910e673).
 *
 * The caller has already checked that the tool_input names the item this session
 * holds, so what remains is: the result is not an error, and it is about that
 * same item. Erring towards clearing is the safe direction — clearing re-locks
 * the gate, while failing to clear leaves it open.
 */
function successfulTerminalResult(response, expectedItemId) {
  const values = decodedResponseValues(response)
  if (values.length === 0 || responseHasError(values)) return false
  if (values.some((value) => value?.success === false || value?.ok === false)) return false
  return values.some((value) => itemIdOf(value) === expectedItemId)
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

function commandFrom(input) {
  return typeof input?.tool_input?.command === 'string' ? input.tool_input.command.trim() : ''
}

/**
 * One quote-aware tokenizer, shared by both gates: returns the command as a list
 * of segments, each a list of words, or null when the command cannot be parsed
 * safely.
 *
 * The previous implementation stripped quote characters while scanning and then
 * re-split each segment on whitespace, so `git -C "/a b/c" log` reached the git
 * check as `-C`, `/a`, `b/c`, `log`: `-C` consumed two words, the verb became
 * `b/c`, and every path containing a space was denied. Every DevSpec plugin
 * checkout on a normal machine sits under such a path (devspec:4910e673).
 *
 * It also rejected the whole command when `<`, `>`, a backtick or `$(` appeared
 * anywhere, including inside quotes where the shell treats them as text.
 *
 * Structure is therefore decided here, with quoting respected:
 *  - `&&`, `||`, `|`, `;` and newlines separate segments; a bare `&` (background)
 *    is refused outright.
 *  - Unquoted `<`, `>`, `(`, `)` and backticks are real shell structure: refused.
 *  - A backtick inside double quotes still substitutes, so it is refused too;
 *    inside single quotes it is literal text.
 *  - `\` + newline is a line continuation, which the documented multi-line
 *    control-plane invocations rely on.
 *  - `$` is preserved as an ordinary character. Deciding what expansion means is
 *    each gate's business: the read-only classifier rejects arguments containing
 *    it (bar the one tolerated `git -C "$VAR"` form), and the commit gate treats
 *    any git command containing it as unverifiable.
 */
function shellSegments(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 16384) return null
  const segments = []
  let words = []
  let word = ''
  let started = false
  let quote = null

  const endWord = () => {
    if (started) { words.push(word); word = ''; started = false }
  }
  const endSegment = (requireContent) => {
    endWord()
    if (words.length) { segments.push(words); words = []; return true }
    return !requireContent
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (quote === "'") {
      if (char === "'") quote = null
      else word += char
      started = true
      continue
    }
    if (quote === '"') {
      if (char === '"') { quote = null; started = true; continue }
      if (char === '`') return null
      if (char === '\\') {
        const next = command[++index]
        if (next === undefined) return null
        if (next !== '\n') word += next
        started = true
        continue
      }
      word += char
      started = true
      continue
    }

    if (char === "'" || char === '"') { quote = char; started = true; continue }
    if (char === '`' || char === '(' || char === ')' || char === '<' || char === '>') return null
    if (char === '\\') {
      const next = command[++index]
      if (next === undefined) return null
      if (next === '\n') continue
      word += next
      started = true
      continue
    }
    if (char === '&') {
      if (command[index + 1] !== '&') return null
      if (!endSegment(true)) return null
      index += 1
      continue
    }
    if (char === '|') {
      if (command[index + 1] === '|') index += 1
      if (!endSegment(true)) return null
      continue
    }
    if (char === ';' || char === '\n') { endSegment(false); continue }
    if (/\s/.test(char)) { endWord(); continue }

    word += char
    started = true
  }

  if (quote) return null
  endSegment(false)
  return segments.length ? segments : null
}

function readOnlyGit(args) {
  let index = 0
  if (args[index] === '-C') {
    const target = args[index + 1]
    if (!target || (target.includes('$') && !/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(target))) return false
    index += 2
  }
  while (['--no-pager', '--no-optional-locks'].includes(args[index])) index += 1
  const verb = args[index]
  const rest = args.slice(index + 1)
  if (!verb || rest.some((arg) => arg.includes('$') || ['--output', '--ext-diff', '--textconv'].includes(arg) || arg.startsWith('--output='))) return false
  if (['status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'grep', 'blame', 'describe', 'for-each-ref', 'cat-file', 'diff-tree', 'diff-index', 'diff-files', 'merge-base', 'shortlog'].includes(verb)) return true
  if (verb === 'branch') return rest.length === 0 || rest.every((arg) => /^(?:-a|--all|-r|--remotes|--list|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--format=|--sort=)/.test(arg))
  if (verb === 'worktree') return rest[0] === 'list'
  if (verb === 'remote') return rest.length === 0 || ['-v', 'show', 'get-url'].includes(rest[0])
  return false
}

/** Conservative read-only compounds are available before tracking; every segment must be safe. */
export function isReadOnlyBootstrapCommand(command) {
  const segments = shellSegments(command)
  if (!segments) return false
  return segments.every((segment) => {
    const words = [...segment]
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      const assignment = words.shift()
      const name = assignment.slice(0, assignment.indexOf('='))
      const value = assignment.slice(assignment.indexOf('=') + 1)
      if (/^(?:PATH|GIT_|LD_|DYLD_|NODE_OPTIONS|BASH_ENV|ENV|SHELL|IFS)/.test(name) || value.includes('$')) return false
    }
    const program = words.shift()
    if (!program) return true
    if (program === 'git') return readOnlyGit(words)
    if (words.some((arg) => arg.includes('$'))) return false
    if (program === 'find') return !words.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg))
    if (program === 'rg') return !words.some((arg) => arg === '--pre' || arg.startsWith('--pre='))
    if (program === 'printf' && words.includes('-v')) return false
    return ['pwd', 'printf', 'echo', 'ls', 'cat', 'head', 'tail', 'grep', 'cut', 'wc', 'stat', 'file', 'readlink', 'realpath', 'basename', 'dirname', 'true', 'false', 'test', '[', 'cd', 'pushd', 'popd'].includes(program)
  })
}

/**
 * This plugin's own control-plane scripts, which a session must be able to run
 * before it holds anything.
 *
 * `/devspec.remote` and `/devspec.remote-stop` are the two commands the plugin
 * still ships, and both are `node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/…"`
 * invocations. Gating them on a claim deadlocked the product: remote control is
 * how an agent becomes reachable for work in the first place, so no claim could
 * ever arrive through that channel (devspec:4910e673).
 *
 * The allowance is deliberately keyed on script identity rather than on the
 * `node` program — a general `node` allowance would be an arbitrary-code hole,
 * since `node -e` mutates anything. The first argument must resolve to a file in
 * this guard's own directory, so an attacker would already need write access to
 * the installed plugin, and the script's own name must be one of these. None of
 * them write to the repository: connect resolves the project, registers the
 * connection and writes state under the user's home directory.
 */
const CONTROL_PLANE_SCRIPTS = new Set([
  'devspec-remote-connect.mjs',
  'devspec-remote-wait.mjs',
  'devspec-remote-poll.mjs',
  'remote-control-state.mjs',
  'mcp-call.mjs',
])

const GUARD_SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** A bare `$NAME` is the documented form (`--owner-pid "$PPID"`); nothing richer. */
function safeControlPlaneArgument(argument) {
  if (argument.includes('`') || argument.includes('${')) return false
  return !/\$(?![A-Za-z_][A-Za-z0-9_]*)/.test(argument)
}

export function isPluginControlPlaneCommand(command) {
  const segments = shellSegments(command)
  if (!segments || segments.length !== 1) return false
  const words = [...segments[0]]
  if (words.shift() !== 'node') return false

  const script = words.shift()
  // Any leading option is refused: that covers -e/-p/--eval/--print/--require
  // and --input-type, i.e. every form where the code is not the named file.
  if (!script || script.startsWith('-') || !path.isAbsolute(script)) return false
  if (!words.every(safeControlPlaneArgument)) return false

  let resolved
  let directory
  try {
    resolved = fs.realpathSync(script)
    directory = fs.realpathSync(GUARD_SCRIPT_DIR)
  } catch {
    return false
  }
  if (path.dirname(resolved) !== directory) return false
  return CONTROL_PLANE_SCRIPTS.has(path.basename(resolved))
}

function gitInvocationOf(words) {
  const gitIndex = words.findIndex((word) => word === 'git' || /(?:^|[\\/])git(?:\.exe)?$/i.test(word))
  if (gitIndex < 0) return null
  if (words[gitIndex] !== 'git') return { unverifiable: true }
  // Expansion could still produce `commit`, so a git segment carrying `$` is
  // never treated as verified — `git co$EMPTYmit -m fix` must not slip through.
  if (words.some((word) => word.includes('$'))) return { unverifiable: true }
  let index = gitIndex + 1
  const valueOptions = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
  while (index < words.length && words[index].startsWith('-')) {
    const option = words[index]
    index += 1
    if (valueOptions.has(option)) index += 1
  }
  if (index >= words.length) return null
  return { subcommand: words[index], args: words.slice(index + 1) }
}

function messageHasClaimTag(args, actionItemId) {
  const required = `[devspec:${actionItemId}]`
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]
    if ((word === '-m' || word === '--message' || /^-[^-]*m$/.test(word)) && args[i + 1]?.includes(required)) return true
    if (word.startsWith('--message=') && word.slice('--message='.length).includes(required)) return true
    if (/^-m.+/.test(word) && word.slice(2).includes(required)) return true
  }
  return false
}

/**
 * Return a deny reason for direct git operations that can create commits
 * without the claim tag. An opaque script/alias remains ordinary claimed Bash
 * and is deliberately documented as a host-observability residual.
 *
 * Each segment of a compound is judged on its own. Refusing every chained git
 * command outright, as this did before, made the ordinary
 * `git add … && git commit -m "… [devspec:<id>]"` impossible for a correctly
 * tracked agent while blocking nothing an attacker could not do in two separate
 * calls (devspec:4910e673).
 */
export function commitGateReason(command, actionItemId) {
  const segments = shellSegments(command)
  if (!segments) {
    return /\bgit\b/i.test(command) ? 'an expanded or chained git command cannot be verified as non-committing' : null
  }
  for (const segment of segments) {
    const reason = segmentCommitReason(segment, actionItemId)
    if (reason) return reason
  }
  return null
}

function segmentCommitReason(words, actionItemId) {
  const invocation = gitInvocationOf(words)
  if (!invocation) return null
  if (invocation.unverifiable) return 'an expanded or chained git command cannot be verified as non-committing'
  const { subcommand, args } = invocation
  if (subcommand === 'commit') {
    if (args.includes('--dry-run')) return null
    return messageHasClaimTag(args, actionItemId) ? null : `git commit needs [devspec:${actionItemId}] in -m/--message`
  }
  if (subcommand === 'merge') {
    if (args.includes('--no-commit') || args.includes('--squash')) return null
    return messageHasClaimTag(args, actionItemId) ? null : `git merge needs [devspec:${actionItemId}] in -m/--message or --no-commit/--squash`
  }
  if (subcommand === 'cherry-pick' || subcommand === 'revert') {
    if (args.includes('--no-commit') || args.includes('-n')) return null
    return `git ${subcommand} can create an untagged commit; use --no-commit and commit separately with the claim tag`
  }
  if (['am', 'rebase', 'pull'].includes(subcommand)) {
    return `git ${subcommand} can create untagged commits; use non-committing steps and an explicit tagged git commit`
  }
  return null
}

/** Backward-compatible test helper for the explicit git commit form. */
export function commitCommandHasClaimTag(command, actionItemId) {
  const segments = shellSegments(command)
  if (!segments || segments.length !== 1) return false
  return gitInvocationOf(segments[0])?.subcommand === 'commit' && commitGateReason(command, actionItemId) === null
}

function canonicalMutationTarget(input, repoRoot) {
  const tool = input.tool_name ?? input.toolName
  const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
  const supplied = input?.tool_input?.[key]
  if (typeof supplied !== 'string' || supplied.length === 0 || supplied.includes('\0')) return null
  let target = path.isAbsolute(supplied) ? path.normalize(supplied) : path.resolve(input.cwd, supplied)
  const missing = []
  while (true) {
    try {
      target = path.join(fs.realpathSync(target), ...missing.reverse())
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') return null
      const parent = path.dirname(target)
      if (parent === target) return null
      missing.push(path.basename(target))
      target = parent
    }
  }
  const relative = path.relative(repoRoot, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) ? target : null
}

export function handleSessionStart() {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `DevSpec implementation contract: ${CONTRACT_URI}`,
    },
  }
}

export function handlePost(input, { env = process.env, now = Date.now() } = {}) {
  const tool = input?.tool_name ?? input?.toolName
  if (tool !== CLAIM_TOOL && !TERMINAL_TOOLS.has(tool)) return null
  let scope
  try { scope = scopeFrom(input) } catch { return null }
  const response = responseFrom(input)
  if (tool === CLAIM_TOOL) {
    const actionItemId = successfulClaimItemId(response, input?.tool_input?.action_item_id)
    if (!actionItemId) return null
    atomicWritePrivate(evidencePathFor(scope, env), {
      schema: 1,
      session_id: scope.sessionId,
      repo_root: scope.repoRoot,
      action_item_id: actionItemId,
      claimed_at: now,
    })
  } else {
    const evidence = readEvidence(scope, { env, now })
    const requested = input?.tool_input?.action_item_id
    if (
      evidence &&
      UUID_RE.test(requested || '') &&
      requested.toLowerCase() === evidence.action_item_id &&
      successfulTerminalResult(response, evidence.action_item_id)
    ) removeEvidence(scope, env)
  }
  return null
}

export function handlePre(input, options = {}) {
  const tool = input?.tool_name ?? input?.toolName
  if (!MUTATION_TOOLS.has(tool)) return null
  let scope
  try { scope = scopeFrom(input) } catch {
    return deny('DevSpec denied mutation because the hook input has no valid session and repository scope.')
  }
  const evidence = readEvidence(scope, options)
  if (!evidence) {
    if (tool === 'Bash') {
      const command = commandFrom(input)
      if (isReadOnlyBootstrapCommand(command) || isPluginControlPlaneCommand(command)) return null
    }
    return deny(
      `DevSpec denied ${tool}: claim the covering work item and retry. Read-only shell investigation and this plugin's own remote-control commands stay available without a claim (${CONTRACT_URI}).`,
    )
  }
  if (tool === 'Bash') {
    const reason = commitGateReason(commandFrom(input), evidence.action_item_id)
    if (reason) return deny(`DevSpec denied Bash: ${reason}.`)
    // No allow decision: arbitrary claimed Bash still goes through Claude's
    // ordinary permission system. The hook cannot inspect opaque subprocesses.
    return null
  }
  // A project-level claim is provenance authority, not filesystem permission.
  // Cross-repository file work still passes through Claude's normal permissions.
  // Silence means this guard passed; Claude's normal permissions still apply.
  return null
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
    if (mode === 'pre') return emit(deny('DevSpec denied mutation because the hook input was malformed.'))
    return
  }
  if (mode === 'pre') return emit(handlePre(input))
  if (mode === 'post') return emit(handlePost(input))
  throw new Error('usage: claim-guard.mjs session-start|pre|post')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    // PreToolUse must fail closed even if state IO or parsing unexpectedly fails.
    if (process.argv[2] === 'pre') {
      emit(deny(`DevSpec denied mutation because the claim guard failed: ${error.message}`))
      process.exitCode = 0
    } else {
      console.error(`DevSpec claim guard failed: ${error.message}`)
      process.exitCode = 1
    }
  })
}
