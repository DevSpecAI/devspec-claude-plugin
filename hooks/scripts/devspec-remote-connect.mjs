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
 *       [--no-poller] [--json]
 *
 * Exit 0 = connected. Exit 1 = connect failed (message on stderr). Exit 2 = bad args.
 */

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpToolsCall, isRetryableHttpFailure } from './mcp-call.mjs'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { isWaitArmed } from './devspec-remote-wait.mjs'
import { renderTiers, storeTiers, hasStoredTiers, mergeInstructionTiers } from './instruction-tiers.mjs'
import { renderRepositoryContext, storeRepositoryContext, takeRepositoryContext } from './repository-context.mjs'
import { roomStatePath, transcriptPaths } from './room-transcript.mjs'
import { startupListenerAlive } from './startup-listener.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'
import { PROJECT_ID, projectCandidate, matchingProjects, readProjectSelection, readConversationProject, saveConversationProject, blockConversationProject } from './conversation-project.mjs'
import {
  detectLocalId,
  resolveLocalAction,
  writeConnectionState,
  knownInstructionTiersFor,
} from './remote-control-state.mjs'

/**
 * Connect is a one-shot command, so a transient failure is the whole command
 * failing: there was no retry here at all, and `/devspec.remote` died outright on
 * `MCP HTTP 502: Bad Gateway` that succeeded on the very next attempt
 * (2026-09-14, item 1f0e1e3b). Three attempts over ~1.5s covers a container swap
 * without making a genuinely-down server feel hung.
 */
const CONNECT_ATTEMPTS = 3
const CONNECT_BACKOFF_MS = [300, 1_200]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run one MCP call, retrying only what the server called retryable or what the
 * status says cannot be a verdict on this request. A rejected credential falls
 * straight through on the first attempt, so a dead token still reports as a dead
 * token instead of as a slow connect.
 *
 * `sleepFn` is injected so tests do not pay the backoff. Exported for tests.
 */
export async function withHttpRetry(invoke, options = {}) {
  const {
    attempts = CONNECT_ATTEMPTS,
    backoff = CONNECT_BACKOFF_MS,
    onRetry = null,
    sleepFn = sleep,
  } = options
  for (let attempt = 0; ; attempt++) {
    try {
      return await invoke()
    } catch (e) {
      if (attempt >= attempts - 1 || !isRetryableHttpFailure(e)) throw e
      if (onRetry) onRetry(e, attempt)
      await sleepFn(backoff[attempt] ?? backoff[backoff.length - 1] ?? 1_200)
    }
  }
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WAIT_SCRIPT = path.join(THIS_DIR, 'devspec-remote-wait.mjs')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--agent' || a === '--agent_name') out.agent = argv[++i]
    else if (a === '--project') {
      if (out.project !== undefined || !argv[i + 1]?.trim() || argv[i + 1].startsWith('--')) throw new ConnectError('Pass one project name or ID after --project.', { code: 2, reason: 'bad_args' })
      out.project = argv[++i]
    }
    else if (a.startsWith('--project=')) throw new ConnectError('Use --project <name-or-id>, with a space before its value.', { code: 2, reason: 'bad_args' })
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--name' || a === '--codename') out.name = argv[++i]
    else if (a === '--title') out.title = argv[++i]
    else if (a === '--local-id' || a === '--local_id') out.localId = argv[++i]
    else if (a === '--owner-pid') out.ownerPid = argv[++i]
    else if (a === '--new') out.new = true
    else if (a === '--private') out.private = true
    else if (a === '--force-new') out.forceNew = true
    else if (a === '--no-poller' || a === '--skip-poller') out.noPoller = true
    else if (a === '--json') out.json = true
    else if (a && !a.startsWith('--')) out._.push(a)
  }
  if (out.project !== undefined && out._.length) throw new ConnectError('Quote a project name containing spaces, or use its full ID.', { code: 2, reason: 'bad_args' })
  return out
}

/**
 * Folder identity — the git remote and the `.devspec/project.json` pin — is shared
 * with the claim guard, which asks the same questions before every mutation, so one
 * implementation lives in `devspec-scope.mjs`. Re-exported here because this module's
 * own callers and tests import them from it.
 */
export { findProjectPin, gitRemoteOrigin }

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

/**
 * A connect that could not complete. `code` is the CLI exit status; `reason` is a
 * stable token a caller that is not a person (the startup listener) can branch on
 * without parsing prose.
 */
export class ConnectError extends Error {
  constructor(message, { code = 1, reason = 'failed', projectSelection = null } = {}) {
    super(message)
    this.name = 'ConnectError'
    this.code = code
    this.reason = reason
    this.projectSelection = projectSelection
  }
}

/**
 * Did the server PROVE a startup registration was scoped by this folder?
 *
 * A registration made when Claude Code starts runs in every folder its user opens, so it
 * must only join a project the folder identifies (item b7ef1fe2). The server honours
 * `folder_scope_only` and echoes it back; a server predating the flag silently drops
 * the argument and may have resolved "your only project" instead. No echo, no trust.
 */
export function startupScopeProven(registration) {
  return registration?.folder_scope_only === true
}

/**
 * The whole deterministic connect, returning a summary instead of printing one.
 *
 * `startup: true` is the variant the listener runs when Claude Code starts, with no
 * model anywhere near it:
 *   - it asks the server to resolve the project from this folder alone, and stands
 *     down if the server cannot prove it did;
 *   - it never echoes the known tier fingerprint, so the server always hands the full
 *     tier texts over — they cost nothing here, because nothing reads them until the
 *     first command arrives, and the listener stores them for exactly that moment;
 *   - it reads no room transcript: orientation is for a model, and there is none yet.
 *
 * `deps` exists for tests. Production callers pass nothing.
 */
export async function connect(options = {}, deps = {}) {
  const {
    session = null,
    new: createNew = false,
    private: makePrivate = false,
    name = null,
    title = null,
    agent = null,
    cwd: cwdArg = null,
    ownerPid = null,
    localId: localIdArg = null,
    forceNew = false,
    noPoller = false,
    startup = false,
    project: projectSelector = null,
    env = process.env,
  } = options
  const {
    callTool = mcpToolsCall,
    writeState = writeConnectionState,
    resolveAuth = resolveDevspecMcpAuth,
    projectHome = os.homedir(),
    onRetryMessage = (message) => process.stderr.write(message),
  } = deps

  const [major] = process.versions.node.split('.')
  if (Number(major) < 18) {
    throw new ConnectError(
      `DevSpec remote control needs Node.js 18 or newer; this is ${process.version}.`,
      { reason: 'node_version' },
    )
  }
  if (startup && (createNew || session)) {
    throw new ConnectError('A startup connect never creates or attaches a session.', {
      code: 2,
      reason: 'bad_args',
    })
  }

  const cwd = cwdArg ? path.resolve(cwdArg) : process.cwd()
  const agentName = agent || AGENT_NAME
  const detected = detectLocalId({ 'local-id': localIdArg }, env)
  const localId = detected.local_id
  const gitRemote = gitRemoteOrigin(cwd)
  const pin = findProjectPin(cwd)
  const previousProject = readConversationProject(localId, { home: projectHome })

  if (startup && !gitRemote && !pin && previousProject?.status !== 'selected') {
    // Nothing about this folder names a project. Not an error: most folders a person
    // opens Claude Code in are not DevSpec projects, and that is fine.
    throw new ConnectError('This folder has no git remote and no .devspec/project.json pin.', {
      reason: 'folder_not_linked',
    })
  }

  const auth = resolveAuth(cwd, { hostToken: hostTokenFromEnv(env), env })
  if (!auth.ok || !auth.token) {
    throw new ConnectError(
      `DevSpec MCP auth could not be resolved: ${auth.error || 'no token found'}\n` +
        'Fix MCP auth (DEVSPEC_MCP_TOKEN, the plugin token, .mcp.json or ~/.claude.json) and retry.',
      { reason: 'auth' },
    )
  }

  if (previousProject && previousProject.endpoint !== auth.mcp_url) {
    throw new ConnectError('This conversation belongs to another DevSpec endpoint. Start a fresh Claude Code conversation.', { reason: 'auth' })
  }

  // The bond decision for THIS conversation — never a cwd scan, never another
  // terminal's connection.
  const bond = resolveLocalAction({
    agent: agentName,
    localId,
    forceNew: !!forceNew || !!createNew,
    maxAgeMinutes: 30,
  })

  const call = (toolName, toolArgs, callOptions = {}) =>
    withHttpRetry(
      () =>
        callTool({
          mcpUrl: auth.mcp_url,
          token: auth.token,
          name: toolName,
          arguments: toolArgs,
          timeoutMs: 30_000,
          ...callOptions,
        }),
      {
        onRetry: (e) =>
          onRetryMessage(`devspec-remote-connect: ${toolName} failed (${e.message}) — retrying\n`),
      },
    )

  let selectedProjectId = previousProject?.status === 'selected' ? previousProject.project.id : null
  let selectedCandidate = null
  if (projectSelector !== null) {
    try {
      const selector = String(projectSelector).trim()
      if (!selector) throw new ConnectError('--project needs a project name or ID.', { code: 2, reason: 'bad_args' })
      if (PROJECT_ID.test(selector)) selectedProjectId = selector.toLowerCase()
      else {
        const listing = await call('list_projects', {})
        if (!Array.isArray(listing.projects)) throw new ConnectError('DevSpec did not return project choices. Retry.', { reason: 'register_refused' })
        const candidates = listing.projects.map(projectCandidate)
        if (candidates.some(candidate => !candidate)) throw new ConnectError('DevSpec returned invalid project choices. Retry without choosing a default.', { reason: 'register_refused' })
        const matches = matchingProjects(candidates, selector)
        if (matches.length !== 1) throw new ConnectError(matches.length ? 'More than one accessible project has that name. Choose an organisation and project ID.' : 'No accessible project has that exact name. Use a full project ID or list the projects.', {
          reason: 'register_refused', projectSelection: { version: 1, status: 'choice_required', reason: matches.length ? 'ambiguous_name' : 'unknown_name', candidates: matches.length ? matches : candidates },
        })
        selectedCandidate = matches[0]
        selectedProjectId = selectedCandidate.id
      }
      if (previousProject?.status === 'selected' && previousProject.project.id !== selectedProjectId) {
        throw new ConnectError('This conversation already uses another project. Start a fresh Claude Code conversation, then run Remote with --project. The existing connection has not changed.', { reason: 'register_refused' })
      }
    } catch (error) {
      blockConversationProject(localId, auth.mcp_url, 'Choose a project explicitly with Remote --project before using project-scoped DevSpec tools.', { home: projectHome })
      throw error
    }
  }

  // 1. Register (idempotent on the conversation bond). Scope goes up as facts —
  //    git_remote and/or the folder pin — and the server arbitrates. No list_projects
  //    round-trip: the router resolves the project from git_remote itself.
  const tierDir = path.join(projectHome, '.devspec', 'remote-control', 'connections')
  const known = startup || !hasStoredTiers(bond.connection_id, {dir:tierDir}) ? null : knownInstructionTiersFor(bond.connection_id)
  let registration
  let connectionCapability = null
  try {
    registration = await call('register_connection', {
      local_id: localId,
      agent_name: agentName,
      cwd,
      machine_hostname: os.hostname(),
      ...(gitRemote ? { git_remote: gitRemote } : {}),
      ...(pin ? { pinned_project_id: pin.project_id } : {}),
      ...(name ? { name } : {}),
      ...(selectedProjectId ? { project_id: selectedProjectId } : {}),
      ...(startup ? { folder_scope_only: true } : {}),
      connection_capability_version: 1,
      project_selection_version: 1,
      ...(known ? { known_instruction_tiers_version: known.version, known_instruction_tiers_hash: known.hash } : {}),
    }, {
      onResultMeta: (meta) => {
        const negotiated = meta?.devspec?.connection_capability
        if (negotiated?.version === 1 && typeof negotiated.value === 'string') {
          connectionCapability = negotiated.value
        }
      },
    })
  } catch (e) {
    const hint =
      !gitRemote && !pin
        ? '\nThis folder has no git remote and no .devspec/project.json pin, so nothing identified the project.'
        : ''
    // `unreachable` is the one failure worth trying again later: the server never gave
    // a verdict. Anything else is an answer — an unlinked folder, a refused token.
    const projectSelection = readProjectSelection(e.details)
    if (projectSelection || projectSelector !== null) blockConversationProject(localId, auth.mcp_url, 'Choose a project explicitly with Remote --project before using project-scoped DevSpec tools.', { home: projectHome })
    throw new ConnectError(`register_connection failed: ${e.message}${hint}`, {
      reason: isRetryableHttpFailure(e) ? 'unreachable' : 'register_refused', projectSelection,
    })
  }

  const connectionId = registration.connection_id
  if (!connectionId) {
    throw new ConnectError(`register_connection returned no connection_id: ${JSON.stringify(registration)}`)
  }
  const codename = registration.codename || null

  if (startup && !startupScopeProven(registration)) {
    // The server did not say it scoped this by folder, so it may have joined "your only
    // project" from an unrelated repository. Take it straight back offline rather than
    // leave an agent on someone's Agents page that nobody meant to put there.
    try {
      await call('heartbeat_connection', {
        connection_id: connectionId,
        status: 'offline',
        end_reason: 'local_stop',
      })
    } catch {
      /* best effort: the poller never started, so it goes stale on its own */
    }
    throw new ConnectError(
      'The DevSpec server did not confirm this registration was scoped by folder; it needs updating before agents can connect themselves at startup.',
      { reason: 'server_scope_unproven' },
    )
  }

  const confirmedProject = projectCandidate(registration.project_selection?.project)
    ?? projectCandidate({ id: registration.project_id, name: selectedCandidate?.name ?? registration.project_id, organization: selectedCandidate?.organization })
  if (!confirmedProject || (selectedProjectId && confirmedProject.id !== selectedProjectId)) {
    throw new ConnectError('DevSpec did not confirm the selected project. No local connection was adopted.', { reason: 'register_refused' })
  }
  const projectState = saveConversationProject(localId, auth.mcp_url, confirmedProject, registration.project_selection?.source ?? 'conversation', { home: projectHome })

  // 2. Session attachment, by invocation. Bare = sessionless, and that is a
  //    first-class outcome, not a degraded one.
  let sessionId = null
  let sessionAccess = null
  let status = registration.created ? 'registered' : 'already live'
  if (createNew) {
    const created = await call('create_session', {
      session_type: 'agent_remote_control',
      agent_name: agentName,
      project_id: confirmedProject.id,
      ...(gitRemote ? { git_remote: gitRemote } : {}),
      ...(pin ? { pinned_project_id: pin.project_id } : {}),
      ...(codename ? { session_codename: codename } : {}),
      machine_hostname: os.hostname(),
      cwd,
      ...(title ? { title } : {}),
      // Shared is the server default and stays that way. A terminal opening the
      // channel is not a reason to make someone's session private.
      ...(makePrivate ? { access: 'private' } : {}),
    })
    sessionId = created.session_id || created.id || null
    sessionAccess = makePrivate ? 'private' : 'shared'
    if (!sessionId) {
      throw new ConnectError(`create_session returned no session id: ${JSON.stringify(created)}`)
    }
    registration = mergeInstructionTiers(registration, await call('attach_connection', { connection_id: connectionId, session_id: sessionId }))
    status = 'attached'
  } else if (session) {
    sessionId = session
    registration = mergeInstructionTiers(registration, await call('attach_connection', { connection_id: connectionId, session_id: sessionId }))
    status = 'attached'
  } else if (bond.action === 'reconnect' && bond.session_id) {
    // Resume exactly what this conversation had — its prior session, nothing else.
    sessionId = bond.session_id
    registration = mergeInstructionTiers(registration, await call('attach_connection', { connection_id: connectionId, session_id: sessionId }))
    status = 'reconnected'
  }
  storeTiers(connectionId, registration, {dir:tierDir})

  // 3. State + bond + poller. One writer, shared with the `write` command.
  const written = await writeState({
    connectionId,
    sessionId,
    agent: agentName,
    cwd,
    localId,
    ownerPid,
    codename,
    title,
    instructionTiers:
      registration.instruction_tiers_hash && registration.instruction_tiers_version
        ? { hash: registration.instruction_tiers_hash, version: registration.instruction_tiers_version }
        : null,
    connectionCapability,
    noPoller: !!noPoller,
    env,
  })

  storeRepositoryContext(connectionId, registration, {
    dir: path.join(projectHome, '.devspec', 'remote-control', 'connections'),
  })

  // The session this connection is ON, which is not the same as one this
  // invocation happened to attach. A bare re-run of an already-attached
  // connection performs no attach, so the local `sessionId` is null while the
  // connection is still very much in a room — reporting "none — available" there
  // would tell the agent to answer with report_progress instead of posting to
  // the room, i.e. answer somewhere the human cannot see.
  const effectiveSessionId = written.session_id || null

  // No room seed (item 7fe8e3d1). The poller writes the whole room to a local
  // transcript as it drains the room's history, and the agent reads as much of it
  // as it needs; a count chosen here would decide for it. This used to fetch the
  // last 40 messages, and the one that mattered could be the forty-first.
  const transcript = effectiveSessionId ? transcriptPaths(connectionId, effectiveSessionId).transcript : null

  // The owner-pid the writer actually resolved (win32 self-resolves it), so the arm
  // line the model runs is already correct rather than something it must assemble.
  const resolvedOwnerPid = written.owner_pid
  const cursorFlag = armCursorFlag({ created: registration.created })
  const armCommand =
    `node ${JSON.stringify(WAIT_SCRIPT)} --connection-id ${connectionId}` +
    `${resolvedOwnerPid ? ` --owner-pid ${resolvedOwnerPid}` : ''} --stream ${cursorFlag}`

  return {
    ok: true,
    status,
    agent_name: agentName,
    codename,
    connection_id: connectionId,
    created: registration.created === true,
    session_id: effectiveSessionId,
    session_access: sessionAccess,
    local_id: localId,
    local_id_source: detected.source,
    project_id: confirmedProject.id,
    project_selection: projectState,
    project_scope: {
      git_remote: gitRemote,
      pinned_project_id: pin?.project_id || null,
      pin_path: pin?.path || null,
      resolved_by_server: true,
      folder_scope_only: startup ? true : undefined,
    },
    mcp_url: written.mcp_url,
    auth_ok: written.auth_ok,
    auth_source: written.auth_source,
    warning: written.warning || null,
    warning_tokens: written.warning_tokens || null,
    warning_poller: written.warning_poller || null,
    warning_local: written.warning_local || null,
    poller: written.poller || null,
    bond_action: bond.action,
    state_path: written.path,
    owner_pid: resolvedOwnerPid,
    cursor_flag: cursorFlag,
    arm_command: armCommand,
    connection_capability_present: !!connectionCapability,
    plan_access: connectionCapability ? 'manage_plan capability ready' : 'unavailable — reconnect/update required',
    // Where the room is: the transcript fills in as the poller drains its history,
    // and the room file says how complete it is.
    transcript,
    room_state: roomStatePath(connectionId),
    // Kept for the CLI's --json and for the startup listener, which files the tier
    // texts for the first command instead of printing them.
    registration,
  }
}

/**
 * The terminal status block for a person (or a model) who ran /devspec.remote.
 * `listenerArmed` is whether something already holds this connection's wake — the
 * listener Claude Code started with the session — in which case arming a second one
 * would have two readers racing for one inbox.
 */
export function renderStatusBlock(summary, { listenerArmed = false, startupListener = false, noPoller = false } = {}) {
  const lines = []
  lines.push('━━━ DevSpec Remote Control ━━━')
  lines.push(`Agent:      ${summary.agent_name} · ${summary.codename || short(summary.connection_id)}`)
  lines.push(`Connection: ${short(summary.connection_id)}`)
  if (summary.project_selection) {
    lines.push(`Project data: ${JSON.stringify({ ...summary.project_selection.project, source: summary.project_selection.source })}`)
  }
  lines.push(
    `Session:    ${summary.session_id ? `${short(summary.session_id)}${summary.session_access ? ` (${summary.session_access})` : ''}` : 'none — available'}`,
  )
  lines.push(`Status:     ${summary.status}`)
  lines.push('Open:       Agents page')
  lines.push('Stop with:  /devspec.remote-stop')
  lines.push('─────────────────────────────')

  const poller = summary.poller
  const pollerText = poller?.skipped
    ? 'skipped (--no-poller) — this connection will NOT receive commands'
    : poller?.ok
      ? `running (pid ${poller.pid})`
      : `NOT RUNNING — ${summary.warning_poller || 'unknown'}`
  lines.push(`poller: ${pollerText} · host: ${summary.mcp_url}`)
  lines.push(`plans: ${summary.connection_capability_present ? 'manage_plan ready' : 'UNAVAILABLE — server did not negotiate capability v1'}`)
  if (!summary.auth_ok) lines.push(`auth: FAILED — ${summary.warning}`)
  if (summary.warning_tokens) lines.push(`warning: ${summary.warning_tokens}`)
  if (!summary.local_id) lines.push(`warning: ${summary.warning_local}`)
  if (!summary.owner_pid && !noPoller) {
    lines.push(
      'warning: no owner pid resolved — pass --owner-pid "$PPID". Without an owner anchor a poller' +
        ' can never be proven dead, so it is refused rather than left to zombie as a "Live" agent.',
    )
  }
  if (!summary.project_scope.git_remote && !summary.project_scope.pinned_project_id && !summary.project_selection) {
    lines.push(
      'scope: no git remote and no .devspec/project.json pin — the server resolved this by token access alone.',
    )
  }

  lines.push('')
  if (listenerArmed) {
    lines.push(
      startupListener
        ? 'wake: ALREADY ARMED — Claude Code started this connection\'s listener with the session.'
        : 'wake: ALREADY ARMED — a listener is already running for this connection.',
    )
    lines.push(
      '  Do NOT arm the Monitor: a second reader would race it for the same inbox. Commands' +
        ' arrive as "DevSpec" monitor events; handle each with the devspec-remote-command skill.',
    )
  } else {
    lines.push('ARM THE WAKE STREAM NOW (Monitor tool — never a background task):')
    lines.push(summary.arm_command)
    lines.push(
      '  (persistent: true if Monitor\'s schema offers it — one arm then lasts the session.' +
        ' If it does not, pass the largest timeout_ms it allows and re-arm with --stream' +
        ' --pending at each expiry; persistent is silently discarded on that schema.)',
    )
    if (summary.cursor_flag === '--pending') {
      lines.push(
        '  (--pending, not --from-end: this connection already existed, so mail may be waiting.' +
          ' --from-end would discard it.)',
      )
    }
  }

  if (summary.transcript) {
    lines.push('')
    lines.push(`Room transcript: ${summary.transcript}`)
    lines.push(
      `  The whole room, filled in by the poller. How complete it is: ${summary.room_state}` +
        ' (the room file). Read it when a command needs the room.',
    )
  }

  const repositories = renderRepositoryContext(summary.registration)
  if (repositories) lines.push(repositories)
  const tiers = renderTiers(summary.registration)
  if (tiers) lines.push(tiers)
  return lines.join('\n') + '\n'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.private && !args.new) {
    process.stderr.write(
      'note: --private only applies with --new (it sets the new session private). Ignored here.\n',
    )
  }
  let summary
  try {
    summary = await connect({
      session: args.session || null,
      project: args.project ?? null,
      new: !!args.new,
      private: !!args.private,
      name: args.name || null,
      title: args.title || null,
      agent: args.agent || null,
      cwd: args.cwd || null,
      ownerPid: args.ownerPid,
      localId: args.localId,
      forceNew: !!args.forceNew,
      noPoller: !!args.noPoller,
    })
  } catch (e) {
    if (e instanceof ConnectError) {
      if (e.projectSelection) process.stdout.write(JSON.stringify({ ok: false, code: 'project_choice_required', project_selection: e.projectSelection }) + '\n')
      process.stderr.write(`${e.message}\n`)
      process.exit(e.code)
    }
    throw e
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    takeRepositoryContext(summary.connection_id, summary.local_id)
    process.exit(0)
  }
  process.stdout.write(
    renderStatusBlock(summary, {
      listenerArmed: isWaitArmed(summary.connection_id),
      startupListener: startupListenerAlive(summary.connection_id),
      noPoller: !!args.noPoller,
    }),
  )
  takeRepositoryContext(summary.connection_id, summary.local_id)
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
