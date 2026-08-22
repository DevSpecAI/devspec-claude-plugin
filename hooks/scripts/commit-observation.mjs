#!/usr/bin/env node
/**
 * Report which commits THIS agent made (item 27fab61a).
 *
 * Separate from `commit-provenance.mjs` on purpose. That module decides whether a
 * commit may proceed, and nothing here may perturb that decision — this only watches
 * and reports. It never denies, never rewrites, and every failure is silent.
 *
 * WHY IT EXISTS: `commits` carries only the git author, which is the machine's git
 * config. Every agent on one machine commits as the same person, so nothing could tell
 * two of the owner's own agents apart. Without this, an action item auto-created from
 * an unlinked commit cannot be attributed to the agent that did the work, and nothing
 * can be told that its commit produced an item.
 *
 * WHY NOT A GIT HOOK: a git hook would see the commit and have no idea which agent made
 * it. This vantage point knows both, and needs nothing installed on the machine.
 *
 * HOW: `git commit -q` prints nothing, so the output cannot be the only source. Two
 * paths, in order:
 *
 *   1. Parse `[branch shortsha]` from the command's own output and resolve it to a full
 *      sha with `git rev-parse`. Worktrees share the object store, so this resolves a
 *      commit made in a linked worktree from anywhere in the repository.
 *   2. Compare HEAD before and after. This is what covers `-q`. HEAD is read in the
 *      directory the command actually commits in — `cd <path> &&` or `git -C <path>`
 *      when the shape says so, otherwise the tool's cwd.
 *
 * Comparing HEAD is also what makes a FAILED commit safe: if nothing was created, HEAD
 * is unchanged and nothing is reported.
 *
 * The connection is chosen by the precise conversation bond only (local_id === this
 * Claude session). The agent-name fallback that `selectBoundState` offers is
 * deliberately NOT used here: it exists for hosts with no conversation id, and picking
 * the wrong connection would attribute someone else's commit to this agent — worse
 * than reporting nothing.
 *
 * JURISDICTION, the same positive test the gate uses. An agent connected to one project
 * still runs commands in other repositories — a scratch clone, an unrelated tool, a
 * throwaway. The connection names the project, so reporting every commit it happens to
 * see would file those against a project they have nothing to do with. Caught by the
 * first live end-to-end run, which cheerfully attributed a commit in a temp repo to the
 * project this agent was connected to.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mcpToolsCall } from './mcp-call.mjs'
import { stateDir } from './commit-provenance.mjs'
import { devspecFolderMarker } from './devspec-scope.mjs'
import { readPrivateJson } from './private-state.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const REPORT_TIMEOUT_MS = 2_500
const FULL_SHA = /^[0-9a-f]{40}$/i

/**
 * Verbs that create exactly one new HEAD. A rebase or an `am` can create many, so they
 * are left to the server-side analyser rather than reported as one commit.
 *
 * The test is deliberately loose: this is an observation, not a gate. A false positive
 * costs one `git rev-parse` and reports nothing (HEAD did not move); a false negative
 * costs the attribution for that commit. Loose is the cheaper mistake.
 */
export function looksCommitProducing(command) {
  if (typeof command !== 'string' || !command) return false
  if (!/\bgit\b/.test(command)) return false
  return /\b(commit|merge|revert|cherry-pick)\b/.test(command)
}

/**
 * Where the commit will land. `cd <path> &&` and `git -C <path>` are the two forms the
 * contract's isolated-worktree workflow actually produces, and each names a directory
 * whose HEAD is the one that moves. Anything else uses the tool's cwd, which is right
 * for the ordinary case and wrong only for shapes nobody writes by hand.
 */
export function commitRepoDir(command, cwd) {
  if (typeof command !== 'string') return cwd
  const viaC = /\bgit\s+(?:--\S+\s+)*-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(command)
  if (viaC) return viaC[2] ?? viaC[3] ?? viaC[4] ?? cwd
  const viaCd = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(command)
  if (viaCd) return viaCd[2] ?? viaCd[3] ?? viaCd[4] ?? cwd
  return cwd
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/** HEAD, or null in a repo with no commits yet (which is not an error here). */
function headOf(dir) {
  const sha = git(['rev-parse', 'HEAD'], dir)
  return sha && FULL_SHA.test(sha) ? sha : null
}

function markerPath(sessionId, repoDir) {
  const digest = crypto.createHash('sha256').update(`${sessionId}\0${repoDir}`).digest('hex')
  return path.join(stateDir(), `${digest}.prehead.json`)
}

/** Remember HEAD before the command runs. Best-effort: a failure just means no report. */
export function rememberHead(sessionId, repoDir, sha, now = Date.now()) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
    fs.writeFileSync(markerPath(sessionId, repoDir), JSON.stringify({ sha, at: now }), {
      mode: 0o600,
    })
  } catch {
    // no marker → the output-parsing path may still catch it
  }
}

/**
 * Read and consume the remembered HEAD, so it can never leak into a later command.
 *
 * Returns `{ sha }` when a marker existed — `sha` may legitimately be null, which means
 * the repository had no commits yet — and `null` when there was NO marker at all.
 *
 * That distinction is load-bearing. Collapsing both into a bare null makes "we do not
 * know what HEAD was" indistinguishable from "there was no HEAD", and the comparison
 * below then reads the CURRENT HEAD as freshly created and attributes somebody else's
 * commit to this agent. Caught by the leak test rather than by inspection.
 */
export function takeHead(sessionId, repoDir) {
  const file = markerPath(sessionId, repoDir)
  let raw
  try {
    raw = readPrivateJson(file)
    if (!raw) return null
  } finally {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* a marker we cannot remove is still consumed for this command */
    }
  }
  return { sha: typeof raw?.sha === 'string' ? raw.sha : null }
}

/** `[staging 5bbfddb] subject` → the short sha. Nothing else in git's output matches. */
export function shortShaFromOutput(output) {
  if (typeof output !== 'string') return null
  const match = /^\[[^\]\s]+(?:\s+\(root-commit\))?\s+([0-9a-f]{7,40})\]/m.exec(output)
  return match ? match[1] : null
}

/**
 * The sha this command created, or null.
 *
 * Output first, because it names the commit directly and is self-evidencing: a
 * `[branch shortsha]` line is only ever printed by a commit that just happened.
 *
 * The before/after comparison second, because it is the only thing that sees a `-q`
 * commit — and ONLY when `before` is a real marker. Without one we do not know where
 * HEAD was, so "HEAD is at X" says nothing about whether this command put it there,
 * and reporting it would attribute an older commit to this agent.
 *
 * Both paths resolve through `git rev-parse`, so a short sha never escapes.
 */
export function createdSha({ output, repoDir, before }) {
  const short = shortShaFromOutput(output)
  if (short) {
    const full = git(['rev-parse', `${short}^{commit}`], repoDir)
    if (full && FULL_SHA.test(full)) return full
  }
  if (!before) return null
  const headAfter = headOf(repoDir)
  if (headAfter && headAfter !== before.sha) return headAfter
  return null
}

/** The connection bound to THIS conversation, by local_id only. Never a guess. */
export function boundConnection(sessionId, dir = CONNECTIONS_DIR) {
  if (!sessionId) return null
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return null
  }
  const candidates = []
  for (const name of names) {
    try {
      const raw = readPrivateJson(path.join(dir, name))
      if (raw?.enabled === true && raw?.connection_id && raw?.local_id === sessionId) {
        candidates.push({ raw, mtime: fs.statSync(path.join(dir, name)).mtimeMs })
      }
    } catch {
      /* skip unreadable state */
    }
  }
  return candidates.sort((a, b) => b.mtime - a.mtime)[0]?.raw ?? null
}

function currentBranch(repoDir) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)
  return branch && branch !== 'HEAD' ? branch : null
}

/**
 * Is this directory one this DevSpec project has jurisdiction over?
 *
 * The same positive marker test the gate applies: without a marker, the folder is not
 * ours and its commits are not ours to report. Uncertainty (a throwing lookup) is
 * treated as "not ours", because a false report is worse than a missing one.
 */
export function inJurisdiction(dir, env = process.env) {
  if (!dir) return false
  try {
    return Boolean(
      devspecFolderMarker(dir, { home: env.USERPROFILE || env.HOME || os.homedir() }),
    )
  } catch {
    return false
  }
}

/** PreToolUse: remember HEAD so a `-q` commit is still detectable afterwards. */
export function handleBashPre(input, { now = Date.now() } = {}) {
  const command = input?.tool_input?.command
  if (!looksCommitProducing(command)) return null
  const sessionId = input?.session_id
  if (!sessionId) return null
  const repoDir = commitRepoDir(command, input?.cwd)
  if (!repoDir) return null
  if (!inJurisdiction(repoDir)) return null
  const head = headOf(repoDir)
  rememberHead(sessionId, repoDir, head, now)
  return null
}

/**
 * PostToolUse: if a commit was created, tell the server which connection made it.
 *
 * Returns null always — this hook has no opinion about anything. Reporting failures
 * (offline, no credentials, server error) are swallowed: provenance is not permission,
 * and the analyser still reconciles the commit without it.
 */
export async function handleBashPost(input, options = {}) {
  const command = input?.tool_input?.command
  if (!looksCommitProducing(command)) return null
  const sessionId = input?.session_id
  if (!sessionId) return null

  const repoDir = commitRepoDir(command, input?.cwd)
  // Jurisdiction again, not only in `pre`: a folder can gain or lose a marker between
  // the two hooks, and this is the call that actually reports.
  const isOurs = options.inJurisdiction ? options.inJurisdiction(repoDir) : inJurisdiction(repoDir)
  if (!isOurs) return null
  const before = takeHead(sessionId, repoDir)
  const output =
    typeof input?.tool_response === 'string'
      ? input.tool_response
      : [input?.tool_response?.stdout, input?.tool_response?.output, input?.tool_response?.stderr]
          .filter((part) => typeof part === 'string')
          .join('\n')

  const sha = options.createdSha
    ? options.createdSha({ output, repoDir, before })
    : createdSha({ output, repoDir, before })
  if (!sha) return null

  const state = (options.boundConnection ?? boundConnection)(sessionId)
  if (!state?.connection_id || !state?.mcp_url || !state?.token) return null

  try {
    await (options.call ?? mcpToolsCall)({
      mcpUrl: state.mcp_url,
      token: state.token,
      name: 'report_commit_provenance',
      arguments: {
        connection_id: state.connection_id,
        commit_sha: sha,
        ...(currentBranch(repoDir) ? { branch: currentBranch(repoDir) } : {}),
      },
      timeoutMs: options.timeoutMs ?? REPORT_TIMEOUT_MS,
    })
  } catch {
    // Provenance is not permission. A commit is already made; nothing here may matter.
  }
  return null
}

async function main() {
  const mode = process.argv[2]
  let input = {}
  try {
    const inputText = fs.readFileSync(0, 'utf8')
    input = JSON.parse(inputText || '{}')
  } catch {
    return
  }
  if (mode === 'pre') handleBashPre(input)
  else if (mode === 'post') await handleBashPost(input)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {})
}
