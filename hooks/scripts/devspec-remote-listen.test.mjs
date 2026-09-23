#!/usr/bin/env node
/**
 * The listener Claude Code starts with the session, and the pieces around it
 * (item b7ef1fe2). Run: node --test hooks/scripts/devspec-remote-listen.test.mjs
 *
 * What matters most here is what must NOT happen: a startup connect that joins a
 * project its folder does not name, a listener that talks on stdout (every line is a
 * model turn), a /clear that leaves the agent deaf, and tier texts overwritten with
 * nothing.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import { connect, ConnectError, renderStatusBlock, startupScopeProven } from './devspec-remote-connect.mjs'
import {
  connectAtStartupEnabled,
  envWithStartupConfig,
  LINK_WATCH_MS,
  readStartupConfig,
  resolveClaudePid,
  WAIT_FOR_LINK_REASONS,
  waitForFolderLink,
} from './devspec-remote-listen.mjs'
import { findProjectPin, folderLinkFingerprint } from './devspec-scope.mjs'
import { renderTiers, storeTiers, takeTiersFor, tiersPath } from './instruction-tiers.mjs'
import {
  findStartupListenerForOwner,
  readLiveStartupListener,
  startupFilePath,
  writeListenerMarker,
  writeStartupConfig,
} from './startup-listener.mjs'
import { startupConfigFromEnv } from './remote-session-lifecycle.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const tmp = []
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmp.push(dir)
  return dir
}
after(() => {
  for (const dir of tmp) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe('a startup connect only joins a project its folder names', () => {
  it('trusts the registration only when the server echoes folder_scope_only', () => {
    assert.equal(startupScopeProven({ folder_scope_only: true }), true)
    assert.equal(startupScopeProven({ folder_scope_only: 'true' }), false)
    assert.equal(startupScopeProven({}), false)
    assert.equal(startupScopeProven(null), false)
  })

  it('stands down in a folder with no git remote and no pin, without calling the server', async () => {
    const folder = tmpDir('devspec-listen-bare-')
    let called = false
    await assert.rejects(
      connect(
        { startup: true, cwd: folder, localId: 'conv-1', env: {} },
        { callTool: async () => { called = true; return {} } },
      ),
      (e) => e instanceof ConnectError && e.reason === 'folder_not_linked',
    )
    assert.equal(called, false, 'an unlinked folder must never reach register_connection')
  })

  it('asks for folder scope, and takes the connection back offline when the server did not prove it', async () => {
    const folder = tmpDir('devspec-listen-pin-')
    fs.mkdirSync(path.join(folder, '.devspec'))
    fs.writeFileSync(path.join(folder, '.devspec', 'project.json'), JSON.stringify({ project_id: 'p-1' }))
    const calls = []
    const callTool = async ({ name, arguments: args }) => {
      calls.push({ name, args })
      if (name === 'register_connection') return { connection_id: 'c-1', created: true }
      return {}
    }
    let wroteState = false
    await assert.rejects(
      connect(
        { startup: true, cwd: folder, localId: 'conv-2', env: { DEVSPEC_MCP_TOKEN: 'dvs_test', DEVSPEC_MCP_URL: 'http://127.0.0.1:1/api/mcp' } },
        { callTool, writeState: async () => { wroteState = true; return {} } },
      ),
      (e) => e instanceof ConnectError && e.reason === 'server_scope_unproven',
    )
    const register = calls.find((c) => c.name === 'register_connection')
    assert.equal(register.args.folder_scope_only, true)
    assert.equal(register.args.pinned_project_id, 'p-1')
    assert.equal(
      'known_instruction_tiers_hash' in register.args,
      false,
      'startup never echoes known tiers: it files the full texts for the first command',
    )
    const offline = calls.find((c) => c.name === 'heartbeat_connection')
    assert.deepEqual(offline?.args, { connection_id: 'c-1', status: 'offline', end_reason: 'local_stop' })
    assert.equal(wroteState, false, 'no state, no poller for a connection we did not keep')
  })

  it('refuses to create or attach a session at startup', async () => {
    await assert.rejects(
      connect({ startup: true, new: true, env: {} }),
      (e) => e instanceof ConnectError && e.reason === 'bad_args',
    )
  })
})

describe('connect_at_startup', () => {
  it('is on unless it is explicitly turned off', () => {
    assert.equal(connectAtStartupEnabled({}), true)
    assert.equal(connectAtStartupEnabled({ CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'true' }), true)
    assert.equal(connectAtStartupEnabled({ CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'garbled' }), true)
    for (const off of ['false', 'FALSE', '0', 'no', 'off']) {
      assert.equal(connectAtStartupEnabled({ CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: off }), false, off)
    }
    assert.equal(connectAtStartupEnabled({}, false), false, 'the startup file carries it too')
  })
})

describe('the listener finds its settings whichever starts first', () => {
  it('does not wait for a file when the environment already carries the key', async () => {
    const config = await readStartupConfig('s-1', {
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_env' },
      waitMs: 10_000,
      sleepFn: () => { throw new Error('must not wait') },
    })
    assert.equal(config, null)
  })

  it('reads the file the SessionStart hook filed', async () => {
    const dir = tmpDir('devspec-startup-')
    assert.equal(writeStartupConfig('s-2', { token: 'dvs_file', mcp_url: 'https://x/api/mcp' }, { dir }), true)
    const mode = fs.statSync(startupFilePath('s-2', dir)).mode & 0o777
    assert.equal(mode, 0o600, 'the file carries a bearer and must be owner-only')
    const config = await readStartupConfig('s-2', { env: {}, dir, waitMs: 0 })
    assert.equal(config.token, 'dvs_file')
    const env = envWithStartupConfig({ OTHER: '1' }, config)
    assert.equal(env.CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN, 'dvs_file')
    assert.equal(env.CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL, 'https://x/api/mcp')
    assert.equal(env.OTHER, '1')
  })

  it('gives up quietly when nothing arrives', async () => {
    const dir = tmpDir('devspec-startup-none-')
    const config = await readStartupConfig('s-3', { env: {}, dir, waitMs: 0 })
    assert.equal(config, null)
  })

  it('files token and URL together, and never without a token', () => {
    assert.equal(startupConfigFromEnv({}), null)
    assert.deepEqual(startupConfigFromEnv({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_a' }), {
      token: 'dvs_a',
      mcp_url: 'https://api.devspec.ai/api/mcp',
    })
    assert.equal(
      startupConfigFromEnv({
        CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_a',
        CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'false',
      }).connect_at_startup,
      'false',
    )
  })
})

describe('instruction tiers wait for the first command', () => {
  const registration = {
    instruction_tiers_version: 1,
    instruction_tiers_hash: 'sha256:aa',
    project_agent_rules: 'Commit only your own files.',
    owner_agent_rules: 'Check UI work in a browser.',
  }

  it('delivers once per conversation, then says unchanged', () => {
    const dir = tmpDir('devspec-tiers-')
    assert.equal(storeTiers('c-1', registration, { dir }), true)
    const first = takeTiersFor('c-1', 'conv-a', { dir })
    assert.equal(first.status, 'deliver')
    assert.match(first.text, /Commit only your own files/)
    assert.match(first.text, /Check UI work in a browser/)
    assert.equal(takeTiersFor('c-1', 'conv-a', { dir }).status, 'unchanged')
    // After /clear the conversation is new and holds none of it.
    assert.equal(takeTiersFor('c-1', 'conv-b', { dir }).status, 'deliver')
  })

  it('never overwrites filed texts with an instructions_unchanged reply', () => {
    const dir = tmpDir('devspec-tiers-keep-')
    storeTiers('c-2', registration, { dir })
    assert.equal(storeTiers('c-2', { instructions_unchanged: true }, { dir }), false)
    assert.match(JSON.parse(fs.readFileSync(tiersPath('c-2', dir), 'utf8')).texts.project_agent_rules, /Commit only/)
  })

  it('reports absence for a connection /devspec.remote made', () => {
    const dir = tmpDir('devspec-tiers-absent-')
    assert.equal(takeTiersFor('c-3', 'conv-a', { dir }).status, 'absent')
  })

  it('renders the same block connect prints', () => {
    assert.match(renderTiers(registration), /## Instructions in force for this run/)
    assert.match(renderTiers({ instructions_unchanged: true }), /unchanged/)
    assert.equal(renderTiers({}), '')
  })
})

describe('a startup listener is found by the process it serves', () => {
  it('proves liveness with the pid, never the file', () => {
    const dir = tmpDir('devspec-marker-')
    writeListenerMarker('c-live', { pid: process.pid, ownerPid: 4242, localId: 'conv-1', dir })
    writeListenerMarker('c-dead', { pid: 999_999_999, ownerPid: 4242, localId: 'conv-0', dir })
    assert.equal(readLiveStartupListener('c-live', dir)?.connection_id, 'c-live')
    assert.equal(readLiveStartupListener('c-dead', dir), null)
    assert.equal(findStartupListenerForOwner(4242, dir)?.connection_id, 'c-live')
    assert.equal(findStartupListenerForOwner(5353, dir), null)
  })
})

describe('resolveClaudePid', () => {
  it('ignores an inherited CLAUDE_PID that is not an ancestor', () => {
    // A pid that is alive but is not this process's ancestor: our own pid.
    const pid = resolveClaudePid({ CLAUDE_PID: String(process.pid) })
    assert.notEqual(pid, process.pid)
  })
})

describe('the listener never speaks on stdout', () => {
  it('stays silent and alive in a folder that names no project', async () => {
    // Every stdout line of a plugin monitor is a model turn. In an unlinked folder the
    // listener must say nothing and must not exit (an ended monitor is announced).
    const home = tmpDir('devspec-listen-home-')
    const folder = tmpDir('devspec-listen-cwd-')
    const child = spawn(process.execPath, [path.join(HERE, 'devspec-remote-listen.mjs')], {
      cwd: folder,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CODE_SESSION_ID: 'listen-test-conv',
        CLAUDE_PID: String(process.pid),
        CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_unused',
        CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: 'http://127.0.0.1:1/api/mcp',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    let exited = false
    child.on('exit', () => { exited = true })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const alive = !exited
    child.kill('SIGKILL')
    assert.equal(stdout, '', 'stdout must stay empty')
    assert.equal(alive, true, 'a dormant listener stays alive')
    const logDir = path.join(home, '.devspec', 'remote-control', 'listen')
    const log = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('')
    assert.match(log, /folder_not_linked/)
  })
})

describe('/clear keeps a connection whose startup listener survives it', () => {
  const CONN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const OLD = '11111111-1111-4111-8111-111111111111'
  const NEW = '22222222-2222-4222-8222-222222222222'

  function seed(home, { listener = true } = {}) {
    const connections = path.join(home, '.devspec', 'remote-control', 'connections')
    const bonds = path.join(home, '.devspec', 'remote-control', 'local', 'claude-code')
    fs.mkdirSync(connections, { recursive: true })
    fs.mkdirSync(bonds, { recursive: true })
    fs.writeFileSync(
      path.join(connections, `${CONN}.json`),
      JSON.stringify({ connection_id: CONN, enabled: true, agent_name: 'Claude Code', local_id: OLD, session_id: 'sess-1', session_codename: 'Test Otter', token: 'dvs_x' }),
      { mode: 0o600 },
    )
    fs.writeFileSync(
      path.join(bonds, `${OLD}.json`),
      JSON.stringify({ connection_id: CONN, agent_name: 'Claude Code', local_id: OLD, status: 'live' }),
      { mode: 0o600 },
    )
    if (listener) {
      fs.writeFileSync(
        path.join(connections, `${CONN}.listener.json`),
        JSON.stringify({ kind: 'startup', connection_id: CONN, pid: process.pid, owner_pid: process.pid, local_id: OLD }),
        { mode: 0o600 },
      )
    }
    return { connections, bonds }
  }

  function runHook(script, args, { home, stdin, env = {}, cwd = home }) {
    return new Promise((resolve) => {
      const base = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env }
      const child = spawn(process.execPath, [path.join(HERE, script), ...args], { env: base, cwd })
      let stdout = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.on('close', (code) => resolve({ code, stdout }))
      child.stdin.end(JSON.stringify(stdin))
    })
  }

  it('SessionEnd(clear) keeps the connection when its startup listener is alive', async () => {
    const home = tmpDir('devspec-clear-keep-')
    const { connections } = seed(home)
    await runHook('remote-control-state.mjs', ['disable-local', '--agent', 'Claude Code'], {
      home,
      stdin: { session_id: OLD, reason: 'clear' },
    })
    const state = JSON.parse(fs.readFileSync(path.join(connections, `${CONN}.json`), 'utf8'))
    assert.equal(state.enabled, true)
    const audit = fs.readFileSync(path.join(connections, `${CONN}.poll.log`), 'utf8')
    assert.match(audit, /connection_kept_for_listener/)
  })

  it('SessionEnd(clear) still disables when no startup listener holds it (the /devspec.remote path)', async () => {
    const home = tmpDir('devspec-clear-nolistener-')
    const { connections } = seed(home, { listener: false })
    await runHook('remote-control-state.mjs', ['disable-local', '--agent', 'Claude Code'], {
      home,
      stdin: { session_id: OLD, reason: 'clear' },
    })
    const state = JSON.parse(fs.readFileSync(path.join(connections, `${CONN}.json`), 'utf8'))
    assert.equal(state.enabled, false)
  })

  it('a real exit still disables, listener or not', async () => {
    const home = tmpDir('devspec-exit-')
    const { connections } = seed(home)
    await runHook('remote-control-state.mjs', ['disable-local', '--agent', 'Claude Code'], {
      home,
      stdin: { session_id: OLD, reason: 'prompt_input_exit' },
    })
    const state = JSON.parse(fs.readFileSync(path.join(connections, `${CONN}.json`), 'utf8'))
    assert.equal(state.enabled, false)
  })

  it('SessionStart(clear) moves the bond to the new conversation', async () => {
    const home = tmpDir('devspec-clear-rebond-')
    const { connections, bonds } = seed(home)
    // The hook resolves its Claude Code process by ancestry; here the test process
    // stands in for it, which is also what the listener marker names as owner.
    await runHook('remote-session-lifecycle.mjs', ['session-start'], {
      home,
      stdin: { session_id: NEW, source: 'clear' },
      env: { CLAUDE_PID: String(process.pid) },
    })
    const bond = JSON.parse(fs.readFileSync(path.join(bonds, `${NEW}.json`), 'utf8'))
    assert.equal(bond.connection_id, CONN)
    assert.equal(bond.status, 'live')
    assert.equal(bond.session_id, 'sess-1')
    const state = JSON.parse(fs.readFileSync(path.join(connections, `${CONN}.json`), 'utf8'))
    assert.equal(state.local_id, NEW)
    const marker = JSON.parse(fs.readFileSync(path.join(connections, `${CONN}.listener.json`), 'utf8'))
    assert.equal(marker.local_id, NEW)
  })

  it('SessionStart(startup) never rebonds: the listener connects by itself', async () => {
    const home = tmpDir('devspec-startup-norebond-')
    const { bonds } = seed(home)
    await runHook('remote-session-lifecycle.mjs', ['session-start'], {
      home,
      stdin: { session_id: NEW, source: 'startup' },
      env: { CLAUDE_PID: String(process.pid) },
    })
    assert.equal(fs.existsSync(path.join(bonds, `${NEW}.json`)), false)
  })

  it('SessionStart files settings privately and SessionEnd removes them', async () => {
    const home = tmpDir('devspec-startup-file-')
    await runHook('remote-session-lifecycle.mjs', ['session-start'], {
      home,
      stdin: { session_id: NEW, source: 'startup' },
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_hook', CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: 'https://s/api/mcp' },
    })
    const file = path.join(home, '.devspec', 'remote-control', 'startup', `${NEW}.json`)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'dvs_hook')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    await runHook('remote-session-lifecycle.mjs', ['session-end'], { home, stdin: { session_id: NEW, reason: 'other' } })
    assert.equal(fs.existsSync(file), false)
  })

  it('the lifecycle hook says nothing where the listener will not connect', async () => {
    const home = tmpDir('devspec-lifecycle-quiet-')
    seed(home)
    const { stdout } = await runHook('remote-session-lifecycle.mjs', ['session-start'], {
      home,
      stdin: { session_id: NEW, source: 'clear' },
      env: { CLAUDE_PID: String(process.pid), CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_q' },
    })
    assert.equal(stdout, '')
  })

  it('tells the model where DevSpec messages come from, only in a folder the listener will connect in', async () => {
    const home = tmpDir('devspec-note-')
    const linked = tmpDir('devspec-note-linked-')
    fs.mkdirSync(path.join(linked, '.devspec'))
    fs.writeFileSync(path.join(linked, '.devspec', 'project.json'), JSON.stringify({ project_id: 'p-1' }))
    const env = { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_n' }
    const { stdout } = await runHook('remote-session-lifecycle.mjs', ['session-start'], {
      home,
      cwd: linked,
      stdin: { session_id: NEW, source: 'startup', cwd: linked },
      env,
    })
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(out.hookSpecificOutput.additionalContext, /post_session_message/)
    assert.match(out.hookSpecificOutput.additionalContext, /cannot see this terminal/)

    const off = await runHook('remote-session-lifecycle.mjs', ['session-start'], {
      home,
      cwd: linked,
      stdin: { session_id: NEW, source: 'startup', cwd: linked },
      env: { ...env, CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'false' },
    })
    assert.equal(off.stdout, '', 'switched off: no note')
  })
})

describe('/devspec.remote says which wake path is active', () => {
  const summary = {
    agent_name: 'Claude Code', codename: 'Test Otter', connection_id: 'c-1', session_id: null,
    status: 'already live', poller: { ok: true, pid: 1 }, mcp_url: 'https://x', auth_ok: true,
    connection_capability_present: true, local_id: 'l', owner_pid: 2,
    project_scope: { git_remote: 'git@x:y.git', pinned_project_id: null },
    arm_command: 'node wait.mjs --connection-id c-1 --stream --pending', cursor_flag: '--pending',
    registration: { instructions_unchanged: true },
  }
  it('prints the arm command when nothing is listening', () => {
    const block = renderStatusBlock(summary, { listenerArmed: false })
    assert.match(block, /ARM THE WAKE STREAM NOW/)
    assert.match(block, /--stream --pending/)
  })
  it('names the startup listener, and never asks for a second reader', () => {
    const block = renderStatusBlock(summary, { listenerArmed: true, startupListener: true })
    assert.match(block, /ALREADY ARMED — Claude Code started this connection's listener/)
    assert.doesNotMatch(block, /ARM THE WAKE STREAM NOW/)
  })
  it('does not claim Claude Code started a listener it did not', () => {
    const block = renderStatusBlock(summary, { listenerArmed: true, startupListener: false })
    assert.match(block, /ALREADY ARMED — a listener is already running/)
  })
})


describe('the skill is loaded once per conversation, not once per message', () => {
  // Measured 2026-09-23: invoking a loaded skill again re-sends its whole body (13.7k
  // characters) although Claude Code labels it "previously loaded". The first wording,
  // "handle each with the … skill", invited exactly that on every message.
  const root = path.resolve(HERE, '../..')
  it('says "once per conversation" everywhere the model is pointed at it', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'))
    const description = manifest.experimental.monitors[0].description
    assert.match(description, /once per conversation/)
    assert.doesNotMatch(description, /handle each with/)
    const { startupNote } = await import('./remote-session-lifecycle.mjs')
    const linked = tmpDir('devspec-note-once-')
    fs.mkdirSync(path.join(linked, '.devspec'))
    fs.writeFileSync(path.join(linked, '.devspec', 'project.json'), JSON.stringify({ project_id: 'p' }))
    assert.match(startupNote({ env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_x' }, cwd: linked }), /once per conversation/)
    const skill = fs.readFileSync(path.join(root, 'skills/devspec-remote-command/SKILL.md'), 'utf8')
    assert.match(skill, /Load this skill once per conversation/)
  })
})

describe('a folder linked mid-session connects without a restart (fa9b809b)', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
  const pin = (dir, id = 'p-1') => {
    fs.mkdirSync(path.join(dir, '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.devspec', 'project.json'), JSON.stringify({ project_id: id }))
  }

  it('the fingerprint moves when a pin or an origin appears, and for nothing else', () => {
    const home = tmpDir('devspec-fp-home-')
    const folder = path.join(home, 'app')
    fs.mkdirSync(folder)
    const fp = () => folderLinkFingerprint(folder, { home })
    const bare = fp()
    fs.writeFileSync(path.join(folder, 'README.md'), 'hello')
    assert.equal(fp(), bare, 'an ordinary file changes nothing')
    git(folder, 'init', '-q')
    const inited = fp()
    assert.notEqual(inited, bare, 'a repository appearing is a change worth a look')
    git(folder, 'status', '--short')
    assert.equal(fp(), inited, 'git writing inside .git (locks, index) is not a change')
    git(folder, 'remote', 'add', 'origin', 'https://github.com/example/app.git')
    const withRemote = fp()
    assert.notEqual(withRemote, inited, 'adding origin rewrites .git/config')
    pin(folder)
    assert.notEqual(fp(), withRemote, 'a pin appearing is a change')
  })

  it('sees the main working tree from a linked worktree', () => {
    const home = tmpDir('devspec-fp-wt-home-')
    const main = path.join(home, 'main')
    fs.mkdirSync(main)
    git(main, 'init', '-q', '-b', 'main')
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root')
    const worktree = path.join(home, 'wt')
    git(main, 'worktree', 'add', '-q', worktree)
    const fp = () => folderLinkFingerprint(worktree, { home })
    const before = fp()
    git(main, 'remote', 'add', 'origin', 'https://github.com/example/main.git')
    const afterRemote = fp()
    assert.notEqual(afterRemote, before, 'the shared config is where the worktree gets origin')
    pin(main)
    assert.notEqual(fp(), afterRemote, "the main tree's pin is one findProjectPin reads")
  })

  it('waits on the fingerprint and runs the real lookup only when it changes', async () => {
    const prints = ['a', 'a', 'b', 'b', 'c']
    let lookups = 0
    const linked = await waitForFolderLink('/x', {
      ownerAlive: () => true,
      fingerprint: () => prints.shift() ?? 'c',
      namesProject: () => ++lookups === 2,
      sleepFn: async () => {},
    })
    assert.equal(linked, true)
    assert.equal(lookups, 2, 'one lookup per change: b still named nothing, c did')
    assert.equal(prints.length, 0)
  })

  it('gives up without a lookup when Claude Code goes', async () => {
    let lookups = 0
    const linked = await waitForFolderLink('/x', {
      ownerAlive: () => false,
      fingerprint: () => String(Math.random()),
      namesProject: () => { lookups++; return true },
      sleepFn: async () => {},
    })
    assert.equal(linked, false)
    assert.equal(lookups, 0)
  })

  it('the pin skill teaches the one shape the reader accepts', () => {
    // Observed 2026-09-23 on Haiku 4.5: asked to "pin this folder", with nothing in
    // context about the file, it wrote {"projectId": ...}; the listener rightly ignored
    // it and the agent never connected. The skill exists so the model is told the shape.
    const skill = fs.readFileSync(path.resolve(HERE, '../../skills/devspec-pin/SKILL.md'), 'utf8')
    const example = /```json\n(\{[^\n]*\})\n```/.exec(skill)?.[1]
    assert.ok(example, 'the skill shows the file as a json block')
    const home = tmpDir('devspec-pin-skill-home-')
    const folder = path.join(home, 'app')
    fs.mkdirSync(path.join(folder, '.devspec'), { recursive: true })
    const id = '11111111-2222-4333-8444-555555555555'
    fs.writeFileSync(path.join(folder, '.devspec', 'project.json'), example.replace("<the project's uuid>", id))
    assert.equal(findProjectPin(folder, { home, root: folder })?.project_id, id)
    assert.match(skill, /name: devspec-pin/)
    // The description is in every session's skill list whether or not the skill is
    // loaded, and the second observed run wrote the right shape WITHOUT loading it — so
    // the shape itself has to be in the part that is always there.
    const description = /^description: (.+)$/m.exec(skill)?.[1] ?? ''
    assert.match(description, /\{"project_id": "<uuid>"\}/)
  })

  it('only the "folder names no project" answers wait; key and install problems stay dormant', () => {
    assert.deepEqual([...WAIT_FOR_LINK_REASONS].sort(), ['folder_not_linked', 'register_refused'])
  })

  it('a real listener stays silent while it waits, notices the pin, and says nothing when it connects', async () => {
    const home = tmpDir('devspec-listen-link-home-')
    const folder = path.join(home, 'greenfield')
    fs.mkdirSync(folder)
    const child = spawn(process.execPath, [path.join(HERE, 'devspec-remote-listen.mjs')], {
      cwd: folder,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CODE_SESSION_ID: 'listen-link-conv',
        CLAUDE_PID: String(process.pid),
        CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_unused',
        // Unreachable on purpose: once linked it tries to register and keeps retrying,
        // which must be just as silent as waiting.
        CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: 'http://127.0.0.1:1/api/mcp',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    let exited = false
    child.on('exit', () => { exited = true })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    pin(folder)
    await new Promise((resolve) => setTimeout(resolve, LINK_WATCH_MS + 2500))
    const alive = !exited
    child.kill('SIGKILL')
    assert.equal(stdout, '', 'stdout must stay empty while waiting and while connecting')
    assert.equal(alive, true)
    const logDir = path.join(home, '.devspec', 'remote-control', 'listen')
    const log = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('')
    assert.match(log, /waiting for this folder to name a project/)
    assert.match(log, /now names a project — connecting/)
    // Unreachable is not a refusal: it retries on the outage schedule rather than going
    // back to waiting for the folder to change.
    assert.match(log, /"retry"/, 'it went on to connect, and rode out the unreachable server')
    assert.doesNotMatch(log, /register_refused/)
  })
})
