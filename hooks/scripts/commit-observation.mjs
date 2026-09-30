#!/usr/bin/env node
/**
 * Best-effort direct-commit observations, never a Git gate (P4 / 3d1f5f9d).
 * A summary line or a changed HEAD alone does not prove creation. Require a
 * bounded readable direct invocation, its own pre/post pair, one new commit
 * reflog entry, parent continuity, and unchanged repository/connection binding.
 * Merge/rewrite/background/opaque commands remain ingestion/analyzer territory.
 * This is same-user operational evidence, not hostile-process attestation.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mcpToolsCall } from './mcp-call.mjs'
import { stateDir, simpleGitCommit, heredocGitCommit } from './commit-provenance.mjs'
import { devspecFolderMarker, findProjectPin, gitRemoteOrigin, mainWorkTreeFrom } from './devspec-scope.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const REPORT_TIMEOUT_MS = 2_500
const OBSERVATION_TTL_MS = 10 * 60_000
const MAX_PENDING = 100
const FULL_SHA = /^[0-9a-f]{40}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

/** Kept for the separate, advisory repository-link nudge; NOT observation proof. */
export function commitRepoDir(command, cwd) {
  if (typeof command !== 'string') return cwd
  const viaC = /\bgit\s+(?:--\S+\s+)*-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(command)
  if (viaC) return viaC[2] ?? viaC[3] ?? viaC[4] ?? cwd
  const viaCd = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(command)
  return viaCd ? viaCd[2] ?? viaCd[3] ?? viaCd[4] ?? cwd : cwd
}

/** Reuse the message reader rather than building a second shell classifier. */
function directInvocation(command, cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  let invocation
  const options = { onInvocation: (value) => { invocation = value } }
  const parsed = simpleGitCommit(command, options) ?? heredocGitCommit(command, options)
  if (!parsed || !invocation) return null
  // The observer's supported direct-creation subset is narrower than the gate.
  // Unknown options, pathspec expansion, dry-run and message-reuse stay unknown.
  const args = invocation.commitArgs
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' || args[i] === '--message') { i++; continue }
    if (/^(?:-m.|--message=)/.test(args[i])) continue
    if (!['-q', '--quiet', '-a', '--all', '--allow-empty', '--allow-empty-message'].includes(args[i])) return null
  }
  let dir = cwd
  for (const change of invocation.directoryChanges) {
    if (!change || /[\x00\r\n*?\[\]~!]/.test(change)) return null
    dir = path.resolve(dir, change)
  }
  const repoDir = git(['rev-parse', '--show-toplevel'], dir)
  if (!repoDir) return null
  return { repoDir: fs.realpathSync(repoDir), subjectHash: digest(parsed.message.split('\n')[0].trim()) }
}

export function looksCommitProducing(command) {
  return Boolean(simpleGitCommit(command) ?? heredocGitCommit(command))
}

/** Credential-bearing/local/unknown remotes are never persisted or transmitted. */
function safeRemote(raw) {
  if (!raw) return null
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(raw)) return raw
  try {
    const url = new URL(raw)
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash) return null
    if (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) return null
    return url.toString()
  } catch { return null }
}

function repositoryBinding(repoDir) {
  if (!inJurisdiction(repoDir)) return null
  const rawRemote = gitRemoteOrigin(repoDir)
  const remote = safeRemote(rawRemote)
  if (rawRemote && !remote) return null
  const pin = findProjectPin(repoDir)?.project_id
  if (pin && !UUID.test(pin)) return null
  if (!remote && !pin) return null
  return { remote, pin: pin ?? null }
}

/** A hash freezes account, endpoint, project (when supplied) and hidden capability;
 * no credential or command text is copied to an observation marker. */
function connectionBinding(state) {
  if (!state?.connection_id || !state?.mcp_url || !state?.token) return null
  return digest([state.connection_id, state.mcp_url, state.token, state.project_id ?? null,
    state.connection_capability ?? null])
}

export function boundConnection(sessionId, dir = CONNECTIONS_DIR) {
  if (!sessionId) return null
  try {
    const candidates = fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name =>
      readPrivateJson(path.join(dir, name))).filter(raw =>
      raw?.enabled === true && raw?.connection_id && raw?.local_id === sessionId)
    // A newer mtime cannot decide which of two live bonds owns this observation.
    return candidates.length === 1 ? candidates[0] : null
  } catch { return null }
}

export function inJurisdiction(dir, env = process.env) {
  try { return Boolean(dir && devspecFolderMarker(dir, {
    home: env.USERPROFILE || env.HOME || os.homedir(), mainWorktree: mainWorkTreeFrom(dir),
  })) }
  catch { return false }
}

function markerPath(input, repoDir) {
  const identity = input.tool_use_id || digest(input.tool_input.command)
  return path.join(stateDir(), `${digest([input.session_id, identity, repoDir])}.observation-v1.json`)
}

function pruneMarkers(now) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  const files = fs.readdirSync(stateDir()).filter(name => name.endsWith('.observation-v1.json'))
    .map(name => { const file = path.join(stateDir(), name); return { file, at: fs.statSync(file).mtimeMs } })
    .sort((a, b) => b.at - a.at)
  for (let i = 0; i < files.length; i++) {
    if (i >= MAX_PENDING - 1 || now - files[i].at > OBSERVATION_TTL_MS) fs.rmSync(files[i].file, { force: true })
  }
}

function readHead(repoDir) {
  const sha = git(['rev-parse', '--verify', 'HEAD^{commit}'], repoDir)
  return sha && FULL_SHA.test(sha) ? sha : null
}
function reflog(repoDir, count) {
  // %gD with --date=raw gives reflog time. %ct is COMMIT time, not reflog time.
  return git(['reflog', 'show', `-${count}`, '--date=raw', '--format=%H%x09%gD%x09%gs', 'HEAD'], repoDir)
}

export function handleBashPre(input, options = {}) {
  try {
    if (!input?.session_id) return null
    const invocation = directInvocation(input?.tool_input?.command, input.cwd)
    if (!invocation) return null
    const { repoDir, subjectHash } = invocation
    const file = markerPath(input, repoDir)
    fs.rmSync(file, { force: true })
    const binding = connectionBinding((options.boundConnection ?? boundConnection)(input.session_id))
    const repository = repositoryBinding(repoDir)
    if (!binding || !repository) return null
    const now = options.now ?? Date.now()
    const sha = readHead(repoDir)
    const priorReflog = reflog(repoDir, 1)
    if (sha && !priorReflog) return null
    const branch = git(['symbolic-ref', '-q', 'HEAD'], repoDir)
    if (!branch) return null // detached HEAD is explicitly unsupported
    pruneMarkers(now)
    writePrivateJson(file, { version: 1, sha, priorReflog, branch, binding, repository,
      subjectHash, at: now, observationId: crypto.randomUUID() })
  } catch { /* observation is never permission */ }
  return null
}

function consumeMarker(file) {
  // Rename claims one marker atomically; duplicate/concurrent posts cannot both read it.
  const consumed = `${file}.consumed-${crypto.randomUUID()}`
  try {
    fs.renameSync(file, consumed)
    return readPrivateJson(consumed)
  } catch { return null }
  finally { try { fs.rmSync(consumed, { force: true }) } catch { /* best effort */ } }
}

function createdSha(repoDir, before, now) {
  const head = readHead(repoDir)
  if (!head || head === before.sha) return null
  if (git(['symbolic-ref', '-q', 'HEAD'], repoDir) !== before.branch) return null
  const entries = (reflog(repoDir, 2) ?? '').split('\n').filter(Boolean)
  const [sha, selector, action] = (entries[0] ?? '').split('\t')
  const epoch = /@\{(\d+) [+-]\d+\}$/.exec(selector ?? '')?.[1]
  const at = Number(epoch) * 1000
  if (sha !== head || !Number.isFinite(at) || at < before.at - 1000 || at > now + 1000) return null
  const parents = git(['rev-list', '--parents', '-n', '1', head], repoDir)?.split(/\s+/).slice(1)
  if (!parents) return null
  if (before.sha) {
    if (parents.length !== 1 || parents[0] !== before.sha || !action?.startsWith('commit: ')) return null
    if (entries[1] !== before.priorReflog) return null
  } else if (parents.length || entries.length !== 1 || !action?.startsWith('commit (initial): ')) return null
  if (digest(git(['show', '-s', '--format=%s', head], repoDir)) !== before.subjectHash) return null
  return head
}

export async function handleBashPost(input, options = {}) {
  try {
    if (!input?.session_id) return null
    const invocation = directInvocation(input?.tool_input?.command, input.cwd)
    if (!invocation) return null
    const { repoDir } = invocation
    const before = consumeMarker(markerPath(input, repoDir))
    const now = options.now ?? Date.now()
    if (!before || before.version !== 1 || !Number.isFinite(before.at) || now < before.at || now - before.at > OBSERVATION_TTL_MS) return null
    const response = input.tool_response
    if (input.is_error === true || response?.is_error === true || response?.interrupted === true ||
        (typeof response?.exit_code === 'number' && response.exit_code !== 0) ||
        (typeof response?.exitCode === 'number' && response.exitCode !== 0)) return null
    const state = (options.boundConnection ?? boundConnection)(input.session_id)
    if (connectionBinding(state) !== before.binding) return null
    const repository = repositoryBinding(repoDir)
    if (!repository || digest(repository) !== digest(before.repository)) return null
    const sha = createdSha(repoDir, before, now)
    if (!sha) return null
    await (options.call ?? mcpToolsCall)({
      mcpUrl: state.mcp_url, token: state.token,
      connectionCapability: state.connection_capability ?? null,
      name: 'report_commit_provenance',
      arguments: { connection_id: state.connection_id, commit_sha: sha,
        observation_id: before.observationId, branch: before.branch.replace(/^refs\/heads\//, ''),
        ...(repository.remote ? { git_remote: repository.remote } : { pinned_project_id: repository.pin }) },
      timeoutMs: options.timeoutMs ?? REPORT_TIMEOUT_MS,
    })
  } catch { /* no retry under a later bond; server ingestion remains the backstop */ }
  return null
}

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
    if (process.argv[2] === 'pre') handleBashPre(input)
    else if (process.argv[2] === 'post') await handleBashPost(input)
  } catch { /* malformed envelopes and every observation failure fail open */ }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => {})
