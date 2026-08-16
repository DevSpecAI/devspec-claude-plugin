#!/usr/bin/env node
/**
 * Mechanical DevSpec connect — the whole deterministic half of `/devspec.remote`
 * in ONE call (item 5a393e4c).
 *
 * The model used to perform this as a nine-step ritual: node preflight, git remote,
 * resolve-local-id, resolve-local, list_projects, register_connection, optional
 * attach/create, write, then read the room. Every step cost a tool call, a result
 * and a line of narration, and none of it needed judgement — which is the definition
 * of work that belongs in a script.
 *
 * What the model still does after this: read the security/authority rules, arm the
 * wake stream, and answer people. That is the part that actually needs a model.
 *
 * Deliberately NOT here: any decision. This script never chooses a project, never
 * picks a session, never invents a connection to reuse. It resolves facts, sends
 * what it found, and lets the SERVER arbitrate (see resolveProjectScope on the
 * server: explicit project_id > single accessible project > git_remote match; the
 * folder pin ranks below a verifiable remote on purpose, so a stale pin copied in
 * with a template self-corrects instead of hijacking the folder).
 *
 * Usage:
 *   node devspec-remote-connect.mjs [--session <uuid> | --new] [--private]
 *       [--name "<codename>"] [--title "…"] [--agent "Claude Code"]
 *       [--cwd <path>] [--owner-pid <pid>] [--local-id <id>] [--force-new]
 *       [--tail <n>] [--no-poller] [--json]
 *
 * Exit 0 = connected. Exit 1 = connect failed (message on stderr). Exit 2 = bad args.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  detectLocalId,
  resolveLocalAction,
  writeConnectionState,
  knownInstructionTiersFor,
} from './remote-control-state.mjs'

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WAIT_SCRIPT = path.join(THIS_DIR, 'devspec-remote-wait.mjs')

/**
 * Orientation window default. Bounded because an unbounded seed re-pays the whole
 * room on every reconnect (measured: one catch-up read cost ~26k tokens). NOT a
 * silent cap — the seed always reports matched/returned/has_more, so an agent that
 * needs more knows there is more and can page for it deliberately.
 */
const DEFAULT_TAIL = 40

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--agent' || a === '--agent_name') out.agent = argv[++i]
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--name' || a === '--codename') out.name = argv[++i]
    else if (a === '--title') out.title = argv[++i]
    else if (a === '--local-id' || a === '--local_id') out.localId = argv[++i]
    else if (a === '--owner-pid') out.ownerPid = argv[++i]
    else if (a === '--tail') out.tail = argv[++i]
    else if (a === '--new') out.new = true
    else if (a === '--private') out.private = true
    else if (a === '--force-new') out.forceNew = true
    else if (a === '--no-poller' || a === '--skip-poller') out.noPoller = true
    else if (a === '--json') out.json = true
    else if (a && !a.startsWith('--')) out._.push(a)
  }
  return out
}

/** `git remote get-url origin`, or null when there is no repo / no origin. */
export function gitRemoteOrigin(cwd) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/** The git repository root for `cwd`, or null when this is not a repo. */
function gitRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return out.trim() ? path.resolve(out.trim()) : null
  } catch {
    return null
  }
}

/**
 * The folder's own `.devspec/project.json` pin: `{ "project_id": "<uuid>" }`.
 *
 * Searched from `cwd` upward, stopping at (and including) the git repository root,
 * and never at or above the home directory — a pin in `~` would silently claim every
 * folder the user owns. The nearest pin wins.
 */
export function findProjectPin(cwd, { home = os.homedir(), root = undefined } = {}) {
  const stopAt = root === undefined ? gitRoot(cwd) : root
  const homeResolved = path.resolve(home)
  let dir = path.resolve(cwd)

  /** True when `dir` IS the home directory or an ancestor of it (`~`, `/home`, `/`). */
  const atOrAboveHome = (d) => {
    const rel = path.relative(d, homeResolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  for (;;) {
    if (atOrAboveHome(dir)) return null
    const candidate = path.join(dir, '.devspec', 'project.json')
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        const id = typeof parsed?.project_id === 'string' ? parsed.project_id.trim() : ''
        if (id) return { project_id: id, path: candidate }
      }
    } catch {
      /* an unreadable or malformed pin is simply not a pin */
    }
    if (stopAt && dir === stopAt) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Short display form for a uuid. */
const short = (id) => (typeof id === 'string' && id.length >= 8 ? `${id.slice(0, 8)}…` : '—')

/**
 * Which cursor flag the printed arm command should carry.
 *
 * `--from-end` does not merely start at EOF: `devspec-remote-wait.mjs` WRITES the
 * new `inbox_byte_offset`, so anything the poller had already written and nobody
 * had read is discarded permanently. That is only safe on a connection that was
 * created moments ago and cannot have an inbox yet.
 *
 * Every other case — a soft reconnect, an already-live conversation re-running
 * connect, a connection being attached to a new session — may have owner mail
 * sitting unread from before, so the cursor must resume from the saved offset.
 *
 * Shipped printing `--from-end` unconditionally, which meant an agent that
 * followed the printed command literally after a reconnect silently dropped
 * whatever arrived while it was away.
 */
export function armCursorFlag({ created } = {}) {
  return created === true ? '--from-end' : '--pending'
}

/** The tier fields the server may hand back, in the order they should be read. */
const TIER_FIELDS = [
  ['owner_custom_instructions', 'Your chat response style'],
  ['owner_agent_rules', 'Your personal agent rules (machine/tooling)'],
  ['project_custom_instructions', 'Project principles (team-wide)'],
  ['project_agent_rules', 'Project agent rules (execution mechanics)'],
]

function renderTiers(payload) {
  if (payload?.instructions_unchanged) {
    return '\nInstructions: unchanged since this conversation last connected — the tiers you already hold still apply.\n'
  }
  const parts = []
  for (const [field, label] of TIER_FIELDS) {
    const value = payload?.[field]
    if (typeof value === 'string' && value.trim()) {
      parts.push(`\n### ${label}\n\n${value.trim()}\n`)
    }
  }
  if (!parts.length) return ''
  return `\n## Instructions in force for this run\n${parts.join('')}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const [major] = process.versions.node.split('.')
  if (Number(major) < 18) {
    process.stderr.write(
      `DevSpec remote control needs Node.js 18 or newer; this is ${process.version}.\n`,
    )
    process.exit(1)
  }
  if (args.private && !args.new) {
    process.stderr.write(
      'note: --private only applies with --new (it sets the new session private). Ignored here.\n',
    )
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd()
  const agentName = args.agent || AGENT_NAME
  const detected = detectLocalId({ 'local-id': args.localId }, process.env)
  const localId = detected.local_id
  const gitRemote = gitRemoteOrigin(cwd)
  const pin = findProjectPin(cwd)

  const auth = resolveDevspecMcpAuth(cwd, { hostToken: hostTokenFromEnv(process.env) })
  if (!auth.ok || !auth.token) {
    process.stderr.write(
      `DevSpec MCP auth could not be resolved: ${auth.error || 'no token found'}\n` +
        'Fix MCP auth (DEVSPEC_MCP_TOKEN, the plugin token, .mcp.json or ~/.claude.json) and retry.\n',
    )
    process.exit(1)
  }

  // The bond decision for THIS conversation — never a cwd scan, never another
  // terminal's connection.
  const bond = resolveLocalAction({
    agent: agentName,
    localId,
    forceNew: !!args.forceNew || !!args.new,
    maxAgeMinutes: 30,
  })

  const call = (name, toolArgs) =>
    mcpToolsCall({ mcpUrl: auth.mcp_url, token: auth.token, name, arguments: toolArgs, timeoutMs: 30_000 })

  // 1. Register (idempotent on the conversation bond). Scope goes up as facts —
  //    git_remote and/or the folder pin — and the server arbitrates. No list_projects
  //    round-trip: the router resolves the project from git_remote itself.
  const known = knownInstructionTiersFor(bond.connection_id)
  let registration
  try {
    registration = await call('register_connection', {
      local_id: localId,
      agent_name: agentName,
      cwd,
      machine_hostname: os.hostname(),
      ...(gitRemote ? { git_remote: gitRemote } : {}),
      ...(pin ? { pinned_project_id: pin.project_id } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(known ? { known_instruction_tiers_version: known.version, known_instruction_tiers_hash: known.hash } : {}),
    })
  } catch (e) {
    const hint =
      !gitRemote && !pin
        ? '\nThis folder has no git remote and no .devspec/project.json pin, so nothing identified the project.'
        : ''
    process.stderr.write(`register_connection failed: ${e.message}${hint}\n`)
    process.exit(1)
  }

  const connectionId = registration.connection_id
  if (!connectionId) {
    process.stderr.write(`register_connection returned no connection_id: ${JSON.stringify(registration)}\n`)
    process.exit(1)
  }
  const codename = registration.codename || null

  // 2. Session attachment, by invocation. Bare = sessionless, and that is a
  //    first-class outcome, not a degraded one.
  let sessionId = null
  let sessionAccess = null
  let status = registration.created ? 'registered' : 'already live'
  if (args.new) {
    const created = await call('create_session', {
      session_type: 'agent_remote_control',
      agent_name: agentName,
      ...(gitRemote ? { git_remote: gitRemote } : {}),
      ...(pin ? { pinned_project_id: pin.project_id } : {}),
      ...(codename ? { session_codename: codename } : {}),
      machine_hostname: os.hostname(),
      cwd,
      ...(args.title ? { title: args.title } : {}),
      // Shared is the server default and stays that way. A terminal opening the
      // channel is not a reason to make someone's session private.
      ...(args.private ? { access: 'private' } : {}),
    })
    sessionId = created.session_id || created.id || null
    sessionAccess = args.private ? 'private' : 'shared'
    if (!sessionId) {
      process.stderr.write(`create_session returned no session id: ${JSON.stringify(created)}\n`)
      process.exit(1)
    }
    await call('attach_connection', { connection_id: connectionId, session_id: sessionId })
    status = 'attached'
  } else if (args.session) {
    sessionId = args.session
    await call('attach_connection', { connection_id: connectionId, session_id: sessionId })
    status = 'attached'
  } else if (bond.action === 'reconnect' && bond.session_id) {
    // Resume exactly what this conversation had — its prior session, nothing else.
    sessionId = bond.session_id
    await call('attach_connection', { connection_id: connectionId, session_id: sessionId })
    status = 'reconnected'
  }

  // 3. State + bond + poller. One writer, shared with the `write` command.
  const written = writeConnectionState({
    connectionId,
    sessionId,
    agent: agentName,
    cwd,
    localId,
    ownerPid: args.ownerPid,
    codename,
    title: args.title,
    instructionTiers:
      registration.instruction_tiers_hash && registration.instruction_tiers_version
        ? { hash: registration.instruction_tiers_hash, version: registration.instruction_tiers_version }
        : null,
    noPoller: !!args.noPoller,
  })

  // The session this connection is ON, which is not the same as one this
  // invocation happened to attach. A bare re-run of an already-attached
  // connection performs no attach, so the local `sessionId` is null while the
  // connection is still very much in a room — reporting "none — available" there
  // would tell the agent to answer with report_progress instead of posting to
  // the room, i.e. answer somewhere the human cannot see.
  const effectiveSessionId = written.session_id || null

  // 4. Orientation seed — bounded, and echoing the tier fingerprint we were just
  //    handed so the same texts are not sent twice inside one connect.
  let seed = null
  if (effectiveSessionId) {
    const tail = Math.max(1, Number.parseInt(String(args.tail ?? DEFAULT_TAIL), 10) || DEFAULT_TAIL)
    try {
      seed = await call('get_session_transcript', {
        session_id: effectiveSessionId,
        tail,
        ...(registration.instruction_tiers_hash && registration.instruction_tiers_version
          ? {
              known_instruction_tiers_version: registration.instruction_tiers_version,
              known_instruction_tiers_hash: registration.instruction_tiers_hash,
            }
          : known
            ? { known_instruction_tiers_version: known.version, known_instruction_tiers_hash: known.hash }
            : {}),
      })
    } catch (e) {
      seed = { error: e.message }
    }
  }

  // The owner-pid the writer actually resolved (win32 self-resolves it), so the arm
  // line the model runs is already correct rather than something it must assemble.
  const ownerPid = written.owner_pid
  const cursorFlag = armCursorFlag({ created: registration.created })
  const armCommand =
    `node ${JSON.stringify(WAIT_SCRIPT)} --connection-id ${connectionId}` +
    `${ownerPid ? ` --owner-pid ${ownerPid}` : ''} --stream ${cursorFlag}`

  const summary = {
    ok: true,
    status,
    agent_name: agentName,
    codename,
    connection_id: connectionId,
    session_id: effectiveSessionId,
    session_access: sessionAccess,
    local_id: localId,
    local_id_source: detected.source,
    project_scope: {
      git_remote: gitRemote,
      pinned_project_id: pin?.project_id || null,
      pin_path: pin?.path || null,
      resolved_by_server: true,
    },
    mcp_url: auth.mcp_url,
    auth_source: written.auth_source,
    poller: written.poller || null,
    bond_action: bond.action,
    state_path: written.path,
    arm_command: armCommand,
    orientation: seed?.transcript_window || (seed?.error ? { error: seed.error } : null),
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...summary, seed, registration }, null, 2) + '\n')
    process.exit(0)
  }

  const lines = []
  lines.push('━━━ DevSpec Remote Control ━━━')
  lines.push(`Agent:      ${agentName} · ${codename || short(connectionId)}`)
  lines.push(`Connection: ${short(connectionId)}`)
  lines.push(
    `Session:    ${effectiveSessionId ? `${short(effectiveSessionId)}${sessionAccess ? ` (${sessionAccess})` : ""}` : "none — available"}`,
  )
  lines.push(`Status:     ${status}`)
  lines.push('Open:       Agents page')
  lines.push('Stop with:  /devspec.remote-stop')
  lines.push('─────────────────────────────')

  const poller = written.poller
  const pollerText = poller?.skipped
    ? 'skipped (--no-poller) — this connection will NOT receive commands'
    : poller?.ok
      ? `running (pid ${poller.pid})`
      : `NOT RUNNING — ${written.warning_poller || 'unknown'}`
  lines.push(`poller: ${pollerText} · host: ${auth.mcp_url}`)
  if (!written.auth_ok) lines.push(`auth: FAILED — ${written.warning}`)
  if (!localId) lines.push(`warning: ${written.warning_local}`)
  if (!ownerPid && !args.noPoller) {
    lines.push(
      'warning: no owner pid resolved — pass --owner-pid "$PPID". Without an owner anchor a poller' +
        ' can never be proven dead, so it is refused rather than left to zombie as a "Live" agent.',
    )
  }
  if (!gitRemote && !pin) {
    lines.push(
      'scope: no git remote and no .devspec/project.json pin — the server resolved this by token access alone.',
    )
  }

  lines.push('')
  lines.push('ARM THE WAKE STREAM NOW (Monitor tool, persistent: true):')
  lines.push(armCommand)
  if (cursorFlag === '--pending') {
    lines.push(
      '  (--pending, not --from-end: this connection already existed, so mail may be waiting.' +
        ' --from-end would discard it.)',
    )
  }

  if (seed?.transcript_window) {
    const w = seed.transcript_window
    lines.push('')
    lines.push(
      `Room seeded: ${w.returned ?? '?'} of ${w.matched ?? '?'} messages` +
        `${w.has_more ? ' — MORE EXIST above this window; page with after_message_id/limit if you need them.' : ' (complete).'}`,
    )
  } else if (seed?.error) {
    lines.push('')
    lines.push(`Room seed failed: ${seed.error} — pull get_session_transcript yourself if you need the room.`)
  }

  const tiers = renderTiers(registration)
  if (tiers) lines.push(tiers)

  process.stdout.write(lines.join('\n') + '\n')
  process.exit(0)
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`devspec-remote-connect failed: ${e?.stack || e?.message || String(e)}\n`)
    process.exit(1)
  })
}
