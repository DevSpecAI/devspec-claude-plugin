/**
 * What the git stand-in (git-shim.mjs) does to a commit before git runs it (item
 * e597bc18): add the task tag, or stop the commit with what to do instead.
 *
 * It works on git's own arguments, after the shell has evaluated the command, so a
 * message written with -m, -m "$(cat <<'EOF' …)", -F <file> or a heredoc into -F -
 * is the same finished text here. The model's command is never read.
 *
 * Which commits: a plain `git commit` in one of the connected project's repositories,
 * by the repository's remote, or in a folder pinned to that project. Anything else is
 * left exactly as it was: other repositories, amend, fixup, squash, reused messages,
 * --no-edit, a message that already carries a reference, and any option this does
 * not know.
 *
 * Imports only Node built-ins: this file is copied next to the stand-in and runs
 * outside the plugin. commit-provenance.mjs uses the same text for its fallback.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'

export const CONTRACT_URI = 'devspec://product/implementation-contract'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Any reference, well formed or not: the stand-in never replaces one. */
export const ANY_REFERENCE = /\[devspec:[^\]\s]*\]/i
const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000
const FUTURE_SKEW_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// The words the model is shown
// ---------------------------------------------------------------------------

export function noClaimText() {
  return [
    'DevSpec: this commit has no [devspec:<id>] reference, so it would land unlinked.',
    'Recover without leaving this turn: search_tasks for the task this work belongs to and claim it;',
    'if none fits, create_task for the smallest adequate task, with a real description of the change and the reason it is needed',
    '(DevSpec refuses a thin or title-only task), and claim that. Then retry the same commit:',
    'with one task claimed, its tag is added for you. Whether to reuse, reopen or create is the',
    `work_entry_contract, and how commits link to work the commit_provenance_contract, in ${CONTRACT_URI}.`,
    'Nothing else is blocked, and no other command is affected.',
  ].join(' ')
}

// The one case the agent writes the tag itself: the plugin never guesses between claims.
export function severalClaimsText(claims) {
  return [
    `DevSpec: this commit has no [devspec:<id>] reference and ${claims.length} claims are active, so nothing was added automatically.`,
    `Pick the one this commit belongs to and put it in the message: ${claims.map((id) => `[devspec:${id}]`).join(' or ')}`,
    'Then retry the commit. Nothing else is blocked.',
  ].join(' ')
}

export function stampedText(id) {
  return `DevSpec: added [devspec:${id}] to this commit's subject, for the one task claimed in this conversation.`
}

// ---------------------------------------------------------------------------
// git commit's arguments
// ---------------------------------------------------------------------------

const SHORT_FLAGS = new Set(['a', 'p', 'q', 'v', 'n', 's', 'e', 'i', 'o', 'z'])
const SHORT_VALUE = new Set(['m', 'F', 'c', 'C', 't'])
const LONG_FLAGS = new Set([
  'all', 'patch', 'interactive', 'quiet', 'verbose', 'dry-run', 'short', 'branch', 'porcelain', 'long', 'null',
  'amend', 'no-edit', 'edit', 'signoff', 'no-signoff', 'no-verify', 'verify', 'allow-empty', 'allow-empty-message',
  'no-post-rewrite', 'include', 'only', 'reset-author', 'status', 'no-status', 'no-gpg-sign', 'pathspec-file-nul',
  'gpg-sign', 'untracked-files',
])
const LONG_VALUE = new Set([
  'message', 'file', 'author', 'date', 'template', 'reuse-message', 'reedit-message', 'fixup', 'squash', 'cleanup',
  'trailer', 'pathspec-from-file',
])
// Attached-only optional values: --gpg-sign[=key], --untracked-files[=mode], -S[key], -u[mode].
const LONG_OPTIONAL = new Set(['gpg-sign', 'untracked-files'])

/**
 * What a `git commit` invocation does with its message. `known: false` means an
 * option this does not recognise: the commit is then left untouched.
 */
export function parseCommitArgs(args) {
  const out = { known: true, reuse: false, amend: false, noEdit: false, edit: false, dryRun: false, template: false, messages: [], files: [] }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') break
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq)
      const attached = eq < 0 ? null : arg.slice(eq + 1)
      let value = attached
      if (LONG_VALUE.has(name)) {
        if (value === null) {
          if (typeof args[i + 1] !== 'string') return { known: false }
          value = args[i + 1]
          i += 1
          if (name === 'message') out.messages.push({ index: i, value, prefix: '' })
          else if (name === 'file') out.files.push({ index: i, value, prefix: '' })
        } else if (name === 'message') out.messages.push({ index: i, value, prefix: '--message=' })
        else if (name === 'file') out.files.push({ index: i, value, prefix: '--file=' })
        if (['reuse-message', 'reedit-message', 'fixup', 'squash'].includes(name)) out.reuse = true
        if (name === 'template') out.template = true
      } else if (LONG_FLAGS.has(name) && (attached === null || LONG_OPTIONAL.has(name))) {
        if (name === 'amend') out.amend = true
        if (name === 'no-edit') out.noEdit = true
        if (name === 'edit') out.edit = true
        if (name === 'dry-run') out.dryRun = true
      } else {
        return { known: false }
      }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j += 1) {
        const flag = arg[j]
        if (SHORT_FLAGS.has(flag)) {
          if (flag === 'e') out.edit = true
          continue
        }
        if (flag === 'S' || flag === 'u') break // optional value, attached: the rest of the word
        if (!SHORT_VALUE.has(flag)) return { known: false }
        const rest = arg.slice(j + 1)
        let value
        let index = i
        let prefix = arg.slice(0, j + 1)
        if (rest) {
          value = rest
        } else {
          if (typeof args[i + 1] !== 'string') return { known: false }
          value = args[i + 1]
          i += 1
          index = i
          prefix = ''
        }
        if (flag === 'm') out.messages.push({ index, value, prefix })
        else if (flag === 'F') out.files.push({ index, value, prefix })
        else if (flag === 't') out.template = true
        else out.reuse = true // -c / -C reuse another commit's message
        break
      }
    }
    // Anything else is a pathspec.
  }
  return out
}

/**
 * The message with the tag at the end of its subject line: the first line that
 * is neither blank nor a comment. Null when there is no such line.
 */
export function tagMessage(text, id) {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  if (at < 0) return null
  const match = /^(.*?)([ \t\r]*)$/s.exec(lines[at])
  lines[at] = `${match[1]} [devspec:${id}]${match[2]}`
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Which repositories: the connected project's, by remote, or a pinned folder
// ---------------------------------------------------------------------------

/** host/owner/repo, lower case, whatever the protocol or user. Null when it is not an address. */
export function normalizeRemote(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  let host
  let pathname
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(value)
  if (scp && !value.includes('://')) {
    host = scp[1]
    pathname = scp[2]
  } else {
    try {
      const url = new URL(value)
      if (!url.hostname || url.protocol === 'file:') return null
      host = url.hostname
      pathname = url.pathname
    } catch {
      return null
    }
  }
  const clean = pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  return clean ? `${host}/${clean}`.toLowerCase() : null
}

/** The connection bound to this conversation: exactly one enabled one. */
export function boundConnectionId(sessionId, home) {
  const dir = join(home, '.devspec', 'remote-control', 'connections')
  const found = new Set()
  let names = []
  try { names = readdirSync(dir) } catch { return null }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue
    try {
      const text = readFileSync(join(dir, name), 'utf8')
      if (!text.includes(sessionId)) continue
      const state = JSON.parse(text)
      if (state?.enabled === true && state.local_id === sessionId && UUID.test(state.connection_id ?? '')) found.add(state.connection_id.toLowerCase())
    } catch { /* a file being rewritten is not a bond */ }
  }
  return found.size === 1 ? [...found][0] : null
}

/** The project and its repositories, as register_connection gave them (repository-context.mjs). */
export function projectRepositories(connectionId, home) {
  try {
    const stored = JSON.parse(readFileSync(join(home, '.devspec', 'remote-control', 'connections', `${connectionId}.repositories.json`), 'utf8'))
    const projectId = UUID.test(stored?.project_id ?? '') ? stored.project_id.toLowerCase() : null
    const data = /<devspec-repository-data>\s*([\s\S]*?)\s*<\/devspec-repository-data>/.exec(String(stored?.text ?? ''))?.[1]
    const facts = data ? JSON.parse(data) : null
    const remotes = new Set()
    for (const repository of Array.isArray(facts?.repositories) ? facts.repositories : []) {
      const fromUrl = normalizeRemote(repository?.git_url)
      if (fromUrl) remotes.add(fromUrl)
      if (repository?.provider === 'github' && typeof repository.full_name === 'string') remotes.add(`github.com/${repository.full_name}`.toLowerCase())
    }
    return { projectId, remotes }
  } catch {
    return { projectId: null, remotes: new Set() }
  }
}

function readPin(dir) {
  try {
    const pin = JSON.parse(readFileSync(join(dir, '.devspec', 'project.json'), 'utf8'))
    return UUID.test(pin?.project_id ?? '') ? pin.project_id.toLowerCase() : null
  } catch {
    return null
  }
}

/** The pin for this worktree: from where git runs up to the worktree's top, then the main worktree. */
function pinFor(cwd, worktree, commonDir) {
  const start = cwd === worktree || cwd.startsWith(worktree + '/') ? cwd : worktree
  for (let dir = start; ; dir = dirname(dir)) {
    const pin = readPin(dir)
    if (pin) return pin
    if (dir === worktree || dirname(dir) === dir) break
  }
  if (commonDir && basename(commonDir) === '.git') return readPin(dirname(commonDir))
  return null
}

/**
 * Whether a commit in this worktree is the connected project's. `git(args)` runs the
 * real git in it and returns stdout or null.
 */
export function projectScope({ cwd, worktree, sessionId, home, git }) {
  const connectionId = boundConnectionId(sessionId, home)
  if (!connectionId) return { inScope: false, reason: 'not connected' }
  const { projectId, remotes } = projectRepositories(connectionId, home)
  const remote = normalizeRemote(git(['remote', 'get-url', 'origin']))
  if (remote && remotes.has(remote)) return { inScope: true, via: 'remote', connectionId, projectId }
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const pin = pinFor(cwd ?? worktree, worktree, common ? resolve(common) : null)
  if (pin && (!projectId || pin === projectId)) return { inScope: true, via: 'pin', connectionId, projectId }
  return { inScope: false, reason: 'not one of the project\'s repositories' }
}

/**
 * The tasks this conversation holds, from the claim records the plugin's hooks keep
 * (commit-provenance.mjs): every repository's, because a claim is the conversation's
 * work wherever it commits.
 */
export function conversationClaims({ sessionId, stateDir, now = Date.now(), platform = process.platform }) {
  const claims = new Set()
  let names = []
  try { names = readdirSync(stateDir) } catch { return [] }
  for (const name of names) {
    if (!name.endsWith('.claims.json')) continue
    try {
      const file = join(stateDir, name)
      const stat = statSync(file)
      if (!stat.isFile() || (platform !== 'win32' && (stat.mode & 0o077) !== 0)) continue
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (record?.schema !== 1 || record.session_id !== sessionId || !Array.isArray(record.claims)) continue
      if (typeof record.updated_at !== 'number' || record.updated_at > now + FUTURE_SKEW_MS || now - record.updated_at > CLAIM_MAX_AGE_MS) continue
      for (const id of record.claims) if (typeof id === 'string' && UUID.test(id)) claims.add(id.toLowerCase())
    } catch { /* not a claim record */ }
  }
  return [...claims].sort() // the same order every time, whichever file was read first
}

/** git in `cwd`, stdout trimmed, or null. */
export function gitIn(realGit, cwd) {
  return (args) => {
    try {
      return execFileSync(realGit, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() || null
    } catch {
      return null
    }
  }
}
