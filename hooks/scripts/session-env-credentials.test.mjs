#!/usr/bin/env node
/**
 * Unit tests for making plugin userConfig reachable from the plugin's own scripts
 * (item bb97c9f6) without putting the key on any command line (item 4d40407b).
 * Claude Code gives `CLAUDE_PLUGIN_OPTION_*` to hooks but not to Bash tool calls, which
 * is where every `commands/*.md` script runs, and it splices the hook-written session
 * env file into each of those calls' argv.
 * Run: node --test hooks/scripts/session-env-credentials.test.mjs
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  buildSessionEnvScript,
  PLUGIN_SETTINGS_KEY_MISSING_MESSAGE,
  PLUGIN_SETTINGS_KEY_VAR,
  removeSessionSettings,
  sweepSessionSettings,
  UNOWNED_SETTINGS_MAX_AGE_MS,
  writeSessionEnvCredentials,
} from './session-env-credentials.mjs'
import {
  PLUGIN_SETTINGS_SESSION_VAR,
  pluginSettingsFromEnv,
  readSessionSettings,
  sessionSettingsPath,
  writeSessionSettings,
} from './plugin-settings.mjs'
import { enumerateCredentialPairs, hostTokenFromEnv } from './resolve-mcp-auth.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROD = 'https://api.devspec.ai/api/mcp'
const STAGING = 'https://api.devspecstaging.com/api/mcp'
const SESSION = '0b6c2a52-7a4e-4b8e-9d1c-3f0e7e2a9c11'
const TOKEN = 'dvs_fixture_only_not_a_real_key_0123456789'

/**
 * The grammar Claude Code's PowerShell tool requires of the joined session env files
 * before it applies ANY of them, read from Claude Code 2.1.301. One line outside it and
 * the PowerShell tool gets no session environment from any hook; and on Windows a value
 * holding `/` or `\` is dropped. The Bash tool splices the same text into argv.
 */
const CLAUDE_CODE_PLAIN_ASSIGNMENT =
  /^(?:\s*(?:#.*)?|(?:export +|declare -x +)?([A-Za-z_]\w*)=((?:[\w@%+=:,./-]|'[^'\0]*'|"(?:[^"\\$`\0]|\\[^\0])*")*))$/

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
      /* ignore */
    }
  }
})

const mode = (file) => fs.statSync(file).mode & 0o777

describe('buildSessionEnvScript', () => {
  const env = { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: TOKEN, CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING }

  it('says nothing when no token is configured, or there is no conversation to name', () => {
    assert.equal(buildSessionEnvScript({}, SESSION), null)
    assert.equal(buildSessionEnvScript({ CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING }, SESSION), null)
    assert.equal(buildSessionEnvScript({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: '   ' }, SESSION), null)
    assert.equal(buildSessionEnvScript(env, null), null)
  })

  it('names the conversation and never carries the key or its server', () => {
    // Item 4d40407b: Claude Code splices this text into every Bash tool call's argv.
    const script = buildSessionEnvScript(env, SESSION)
    assert.ok(!script.includes(TOKEN), 'the key must never be in the session env file')
    assert.ok(!script.includes('dvs_'), 'nothing key-shaped either')
    assert.doesNotMatch(script, /DEVSPEC_TOKEN|DEVSPEC_MCP_URL/)
    assert.match(script, new RegExp(`^export ${PLUGIN_SETTINGS_SESSION_VAR}='${SESSION}'$`, 'm'))
  })

  it('carries connect_at_startup only when it is set', () => {
    assert.doesNotMatch(buildSessionEnvScript(env, SESSION), /CONNECT_AT_STARTUP/)
    const script = buildSessionEnvScript({ ...env, CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'false' }, SESSION)
    assert.match(script, /^export CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP='false'$/m)
  })

  it("is all plain assignments with no path in a value, so Claude Code's PowerShell tool keeps it", () => {
    for (const script of [
      buildSessionEnvScript({ ...env, CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'true' }, SESSION),
      // A conversation id from an unexpected host is reduced to file-name characters.
      buildSessionEnvScript(env, '../../etc/passwd'),
    ]) {
      for (const line of script.split('\n')) {
        const m = CLAUDE_CODE_PLAIN_ASSIGNMENT.exec(line)
        assert.ok(m, `not a plain assignment: ${line}`)
        if (m[2] !== undefined) assert.doesNotMatch(m[2], /[/\\]/, `path separator in ${line}`)
      }
    }
  })

  it('quotes a value that would otherwise break out of the shell', () => {
    const script = buildSessionEnvScript(
      { ...env, CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: `x'; touch /tmp/pwned; '` },
      SESSION,
    )
    assert.match(script, /^export CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP='x'\\''; touch \/tmp\/pwned; '\\'''$/m)
  })
})

describe('writeSessionEnvCredentials', () => {
  let dir
  let settingsDir

  before(() => {
    dir = tmpDir('devspec-session-env-')
    settingsDir = path.join(tmpDir('devspec-session-settings-'), 'startup')
  })

  const hookEnv = (target, extra = {}) => ({
    CLAUDE_ENV_FILE: target,
    CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: TOKEN,
    CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
    ...extra,
  })

  it('files the pair privately and points the session environment at it', () => {
    const target = path.join(dir, 'sessionstart-hook-0.sh')
    const result = writeSessionEnvCredentials({
      env: hookEnv(target),
      sessionId: SESSION,
      dir: settingsDir,
      owner: { pid: 4242, started: '99' },
    })
    assert.deepEqual(result, { written: true, filed: true, reason: 'ok' })

    const written = fs.readFileSync(target, 'utf8')
    assert.ok(!written.includes(TOKEN))
    assert.match(written, new RegExp(`${PLUGIN_SETTINGS_SESSION_VAR}='${SESSION}'`))

    const file = sessionSettingsPath(SESSION, settingsDir)
    assert.equal(mode(file), 0o600, 'the settings file holds the key and must be owner-only')
    assert.equal(mode(settingsDir), 0o700)
    const filed = readSessionSettings(SESSION, { dir: settingsDir })
    assert.equal(filed.token, TOKEN)
    assert.equal(filed.mcp_url, STAGING)
    assert.equal(filed.owner_pid, 4242)
    assert.equal(filed.owner_started, '99')
  })

  it('never writes a token without its URL — the 8bb707fd pairing invariant', () => {
    const target = path.join(dir, 'pair.sh')
    writeSessionEnvCredentials({
      env: { CLAUDE_ENV_FILE: target, CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_alone' },
      sessionId: 'pair-session',
      dir: settingsDir,
      owner: null,
    })
    assert.equal(readSessionSettings('pair-session', { dir: settingsDir }).mcp_url, PROD)
  })

  it('tightens a settings file that was left readable by others', () => {
    fs.mkdirSync(settingsDir, { recursive: true })
    const file = sessionSettingsPath('loose', settingsDir)
    fs.writeFileSync(file, '{}', { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    fs.chmodSync(settingsDir, 0o755)
    writeSessionEnvCredentials({ env: hookEnv(path.join(dir, 'loose.sh')), sessionId: 'loose', dir: settingsDir, owner: null })
    assert.equal(mode(file), 0o600)
    assert.equal(mode(settingsDir), 0o700)
  })

  it('replaces what an earlier version left in the env file, key included', () => {
    // Before 0.46.1 this file exported the key itself; a resumed session re-runs the
    // hook on the same file, and nothing of the old content may survive.
    const target = path.join(dir, 'sessionstart-hook-1.sh')
    fs.writeFileSync(target, `export CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN='${TOKEN}'\n`)
    writeSessionEnvCredentials({ env: hookEnv(target), sessionId: SESSION, dir: settingsDir, owner: null })
    writeSessionEnvCredentials({ env: hookEnv(target), sessionId: SESSION, dir: settingsDir, owner: null })
    const written = fs.readFileSync(target, 'utf8')
    assert.ok(!written.includes(TOKEN))
    assert.equal(written.split('\n').filter((l) => l.startsWith('export ')).length, 1)
  })

  it('still files the settings when Claude Code sets no CLAUDE_ENV_FILE', () => {
    // An older host, or a hook event that does not get one: the listener reads the
    // file by its own conversation id.
    const result = writeSessionEnvCredentials({
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: TOKEN },
      sessionId: 'no-env-file',
      dir: settingsDir,
      owner: null,
    })
    assert.deepEqual(result, { written: false, filed: true, reason: 'no_env_file' })
    assert.equal(readSessionSettings('no-env-file', { dir: settingsDir }).token, TOKEN)
  })

  it('marks the session, and files nothing, when the plugin settings hold no key', () => {
    // Item 721f9c67: the connect script runs as a Bash tool call and cannot see the
    // plugin settings, so this hook is the only thing that can tell it.
    const target = path.join(dir, 'no-key.sh')
    const result = writeSessionEnvCredentials({ env: { CLAUDE_ENV_FILE: target }, sessionId: 'no-key', dir: settingsDir })
    assert.deepEqual(result, { written: true, filed: false, reason: 'no_token' })
    const written = fs.readFileSync(target, 'utf8')
    assert.match(written, new RegExp(`^export ${PLUGIN_SETTINGS_KEY_VAR}='missing'$`, 'm'))
    assert.doesNotMatch(written, new RegExp(PLUGIN_SETTINGS_SESSION_VAR))
    assert.equal(fs.existsSync(sessionSettingsPath('no-key', settingsDir)), false)
  })

  it('drops the marker once the key is in the plugin settings', () => {
    const target = path.join(dir, 'key-added.sh')
    writeSessionEnvCredentials({ env: { CLAUDE_ENV_FILE: target }, sessionId: 'key-added', dir: settingsDir })
    writeSessionEnvCredentials({ env: hookEnv(target), sessionId: 'key-added', dir: settingsDir, owner: null })
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), new RegExp(PLUGIN_SETTINGS_KEY_VAR))
  })

  it('never falls back to exporting the key when the settings cannot be filed', () => {
    const blocked = path.join(dir, 'not-a-directory')
    fs.writeFileSync(blocked, '')
    const target = path.join(dir, 'unfiled.sh')
    const result = writeSessionEnvCredentials({
      env: hookEnv(target, { CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'false' }),
      sessionId: SESSION,
      dir: blocked,
      owner: null,
    })
    assert.deepEqual(result, { written: true, filed: false, reason: 'settings_not_filed' })
    const written = fs.readFileSync(target, 'utf8')
    assert.ok(!written.includes(TOKEN))
    assert.doesNotMatch(written, new RegExp(PLUGIN_SETTINGS_SESSION_VAR))
    assert.match(written, /CONNECT_AT_STARTUP='false'/, 'the non-secret choice is still carried')
  })

  it('degrades quietly when the env file cannot be written', () => {
    const result = writeSessionEnvCredentials({
      env: hookEnv(path.join(dir, 'no-such-dir', 'hook.sh')),
      sessionId: 'unwritable',
      dir: settingsDir,
      owner: null,
    })
    assert.deepEqual(result, { written: false, filed: true, reason: 'write_failed' })
  })
})

describe('the route a Bash tool call takes, end to end', { skip: process.platform === 'win32' }, () => {
  // Run the real hook as Claude Code does, then splice the env file's text into a
  // shell's own argv exactly as Claude Code 2.1.301 builds a Bash tool call, and run
  // the resolver there. Proves the key reaches the plugin's scripts while appearing in
  // neither that argv nor the file it came from.
  it("resolves the plugin's own pair, and the key is in no argv", () => {
    const home = tmpDir('devspec-session-env-route-')
    const envFile = path.join(home, 'sessionstart-hook-2.sh')
    const base = { PATH: process.env.PATH, HOME: home, USERPROFILE: home }
    const hook = spawnSync(process.execPath, [path.join(HERE, 'session-env-credentials.mjs')], {
      env: {
        ...base,
        CLAUDE_ENV_FILE: envFile,
        CLAUDE_PID: String(process.pid),
        CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: TOKEN,
        CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
      },
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION, source: 'startup' }),
      encoding: 'utf8',
    })
    assert.equal(hook.status, 0, hook.stderr)
    const settingsFile = path.join(home, '.devspec', 'remote-control', 'startup', `${SESSION}.json`)
    assert.equal(mode(settingsFile), 0o600)

    const envText = fs.readFileSync(envFile, 'utf8').trim()
    const resolver = path.join(HERE, 'resolve-mcp-auth.mjs')
    const command = `true 2>/dev/null || true && ${envText}\n: && node '${resolver}'`
    assert.ok(!command.includes(TOKEN), 'the Bash tool argv must not carry the key')
    const call = spawnSync('sh', ['-c', command], { env: base, cwd: home, encoding: 'utf8' })
    assert.equal(call.status, 0, call.stderr)
    const resolved = JSON.parse(call.stdout)
    assert.equal(resolved.token, TOKEN)
    assert.equal(resolved.mcp_url, STAGING)
    // The CLI resolves as connect does, offering the plugin key as the host's own (source 2).
    assert.equal(resolved.source, 'host')

    // SessionEnd removes it.
    const end = spawnSync(process.execPath, [path.join(HERE, 'session-env-credentials.mjs'), 'session-end'], {
      env: { ...base, CLAUDE_PID: String(process.pid) },
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: SESSION, reason: 'other' }),
      encoding: 'utf8',
    })
    assert.equal(end.status, 0, end.stderr)
    assert.equal(fs.existsSync(settingsFile), false)
  })
})

describe('precedence is carried, not changed (the reason for reading at source 6)', () => {
  let projectDir
  let settingsDir

  before(() => {
    projectDir = tmpDir('devspec-session-env-proj-')
    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          devspec: {
            url: 'https://local.example/api/mcp',
            headers: { Authorization: 'Bearer dvs_project' },
          },
        },
      }),
    )
    settingsDir = tmpDir('devspec-session-env-settings-')
    writeSessionSettings(SESSION, { token: 'dvs_plugin', mcp_url: STAGING }, { dir: settingsDir })
  })

  const bashEnv = { [PLUGIN_SETTINGS_SESSION_VAR]: SESSION }

  it("a developer's project .mcp.json still outranks the plugin's own config", () => {
    const { pairs } = enumerateCredentialPairs(projectDir, { env: bashEnv, pluginSettingsDir: settingsDir })
    assert.equal(pairs[0].token, 'dvs_project')
    assert.equal(pairs[0].mcp_url, 'https://local.example/api/mcp')
    const plugin = pairs.find((p) => p.source === 'plugin_user_config')
    assert.equal(plugin.token, 'dvs_plugin')
    assert.equal(plugin.mcp_url, STAGING)
  })

  it('the filed pair resolves on its own when nothing else is configured', () => {
    const empty = tmpDir('devspec-session-env-empty-')
    const { pairs } = enumerateCredentialPairs(empty, { env: bashEnv, pluginSettingsDir: settingsDir })
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].token, 'dvs_plugin')
    assert.equal(pairs[0].mcp_url, STAGING)
  })

  it("a hook's own environment wins over the file, and hooks read no file", () => {
    const settings = pluginSettingsFromEnv(
      { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_hook', ...bashEnv },
      { dir: settingsDir },
    )
    assert.equal(settings.token, 'dvs_hook')
    assert.equal(settings.mcp_url, PROD)
    assert.equal(settings.carried, 'hook_environment')
  })

  it('the host token is the filed key in a Bash tool call', () => {
    assert.equal(pluginSettingsFromEnv(bashEnv, { dir: settingsDir }).carried, 'session_file')
    assert.equal(hostTokenFromEnv({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_hook' }), 'dvs_hook')
    assert.equal(hostTokenFromEnv({}), null)
  })

  it('reads nothing for a conversation that has no file', () => {
    assert.equal(pluginSettingsFromEnv({ [PLUGIN_SETTINGS_SESSION_VAR]: 'other' }, { dir: settingsDir }), null)
  })
})

describe('settings files do not outlive their session', () => {
  const NOW = 1_800_000_000_000

  function file(dir, id, value, ageMs = 0) {
    const target = path.join(dir, `${id}.json`)
    fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600 })
    const t = new Date(NOW - ageMs)
    fs.utimesSync(target, t, t)
    return target
  }

  it('removes a file whose Claude Code process has gone, and keeps a live one', () => {
    const dir = tmpDir('devspec-sweep-')
    const dead = file(dir, 'dead', { token: 'dvs_x', owner_pid: 111, owner_started: '5' })
    const live = file(dir, 'live', { token: 'dvs_x', owner_pid: 222, owner_started: '7' })
    const reused = file(dir, 'reused', { token: 'dvs_x', owner_pid: 333, owner_started: '8' })
    const removed = sweepSessionSettings({
      dir,
      now: NOW,
      isAlive: (pid) => pid !== 111,
      startTimeOf: (pid) => (pid === 333 ? '9' : '7'),
    })
    assert.deepEqual(removed.sort(), ['dead.json', 'reused.json'])
    assert.equal(fs.existsSync(dead), false)
    assert.equal(fs.existsSync(live), true)
    assert.equal(fs.existsSync(reused), false, 'a reused pid is a different process')
  })

  it('removes a file that names no owner once it is a day old', () => {
    // Files from before 0.46.1 recorded no owner.
    const dir = tmpDir('devspec-sweep-unowned-')
    const old = file(dir, 'old', { token: 'dvs_x' }, UNOWNED_SETTINGS_MAX_AGE_MS + 1000)
    const young = file(dir, 'young', { token: 'dvs_x', owner_pid: null }, 60_000)
    sweepSessionSettings({ dir, now: NOW, isAlive: () => true, startTimeOf: () => null })
    assert.equal(fs.existsSync(old), false)
    assert.equal(fs.existsSync(young), true)
  })

  it("never removes the starting conversation's own file, or one it cannot read", () => {
    const dir = tmpDir('devspec-sweep-keep-')
    const own = file(dir, SESSION, { token: 'dvs_x', owner_pid: 111 })
    const torn = path.join(dir, 'torn.json')
    fs.writeFileSync(torn, '{"tok', { mode: 0o600 })
    sweepSessionSettings({ dir, keep: SESSION, now: NOW, isAlive: () => false })
    assert.equal(fs.existsSync(own), true)
    assert.equal(fs.existsSync(torn), true)
  })

  it('SessionEnd removes its own file but not one another live window re-filed', () => {
    const dir = tmpDir('devspec-session-end-')
    writeSessionSettings('mine', { token: 'dvs_x' }, { dir, owner: { pid: 500 } })
    assert.equal(removeSessionSettings('mine', { dir, ownerPid: 500, isAlive: () => true }).removed, true)

    writeSessionSettings('resumed', { token: 'dvs_x' }, { dir, owner: { pid: 600 } })
    const kept = removeSessionSettings('resumed', { dir, ownerPid: 500, isAlive: () => true })
    assert.deepEqual(kept, { removed: false, reason: 'owned_by_another_process' })
    assert.equal(removeSessionSettings('resumed', { dir, ownerPid: 500, isAlive: () => false }).removed, true)
  })
})

describe('the hook tells the person when the plugin settings hold no key (item 721f9c67)', () => {
  // Run the real hook as Claude Code does: it is the person-facing surface, because
  // with no key Claude Code also refuses the module that would draw the status line.
  const script = fileURLToPath(new URL('./session-env-credentials.mjs', import.meta.url))
  let dir
  before(() => { dir = tmpDir('devspec-session-env-hook-') })

  function runHook(extraEnv) {
    const env = { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, CLAUDE_ENV_FILE: path.join(dir, `hook-${Math.random()}.sh`), ...extraEnv }
    return spawnSync(process.execPath, [script], {
      env,
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'notice-session' }),
      encoding: 'utf8',
    })
  }

  it('shows the notice as a systemMessage when no key is set', () => {
    const run = runHook({})
    assert.equal(run.status, 0)
    assert.deepEqual(JSON.parse(run.stdout), { systemMessage: PLUGIN_SETTINGS_KEY_MISSING_MESSAGE })
  })

  it('says nothing when the key is set', () => {
    const run = runHook({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_set' })
    assert.equal(run.status, 0)
    assert.equal(run.stdout, '')
  })

  it('names what is off and the step that fixes it, in words a customer can act on', () => {
    // The notice is a contract with the person reading it: the menu path must match
    // the README's, and none of our own machinery may leak into it.
    assert.match(PLUGIN_SETTINGS_KEY_MISSING_MESSAGE, /\/plugin → Installed → DevSpec, press Enter/)
    assert.doesNotMatch(PLUGIN_SETTINGS_KEY_MISSING_MESSAGE, /hooks? module|userConfig|CLAUDE_PLUGIN_OPTION|721f9c67/i)
  })
})
