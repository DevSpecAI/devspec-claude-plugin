#!/usr/bin/env node
/**
 * Unit tests for making the plugin's own settings — its DevSpec server and the
 * connect-at-startup choice — reachable from the plugin's own scripts (item bb97c9f6)
 * with nothing on a command line beyond a conversation id (item 4d40407b). Claude Code
 * gives `CLAUDE_PLUGIN_OPTION_*` to hooks but not to Bash tool calls, which is where
 * every `commands/*.md` script runs. Since browser sign-in (item 47f0dbdf) no credential
 * passes through here at all.
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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROD = 'https://api.devspec.ai/api/mcp'
const STAGING = 'https://api.devspecstaging.com/api/mcp'
const SESSION = '0b6c2a52-7a4e-4b8e-9d1c-3f0e7e2a9c11'
const OLD_KEY = 'dvs_fixture_only_not_a_real_key_0123456789'

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
  const env = { CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING }

  it('says nothing without a conversation to name', () => {
    assert.equal(buildSessionEnvScript(env, null), null)
    assert.equal(buildSessionEnvScript(env, '..'), null)
  })

  it('names the conversation, and carries neither a credential nor the server', () => {
    // Item 4d40407b: Claude Code splices this text into every Bash tool call's argv.
    for (const script of [buildSessionEnvScript(env, SESSION), buildSessionEnvScript({}, SESSION)]) {
      assert.ok(!script.includes('dvs_'), 'nothing key-shaped')
      assert.doesNotMatch(script, /TOKEN|DEVSPEC_MCP_URL/)
      assert.match(script, new RegExp(`^export ${PLUGIN_SETTINGS_SESSION_VAR}='${SESSION}'$`, 'm'))
    }
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
    CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
    ...extra,
  })

  it('files the server privately and points the session environment at it', () => {
    const target = path.join(dir, 'sessionstart-hook-0.sh')
    const result = writeSessionEnvCredentials({
      env: hookEnv(target),
      sessionId: SESSION,
      dir: settingsDir,
      owner: { pid: 4242, started: '99' },
    })
    assert.deepEqual(result, { written: true, filed: true, reason: 'ok' })
    assert.match(fs.readFileSync(target, 'utf8'), new RegExp(`${PLUGIN_SETTINGS_SESSION_VAR}='${SESSION}'`))

    const file = sessionSettingsPath(SESSION, settingsDir)
    assert.equal(mode(file), 0o600)
    assert.equal(mode(settingsDir), 0o700)
    const filed = readSessionSettings(SESSION, { dir: settingsDir })
    assert.equal(filed.mcp_url, STAGING)
    assert.equal(filed.token, undefined, 'no credential is filed')
    assert.equal(filed.owner_pid, 4242)
    assert.equal(filed.owner_started, '99')
  })

  it('files the default server when Claude Code hands the hook no setting', () => {
    const target = path.join(dir, 'default.sh')
    const result = writeSessionEnvCredentials({ env: { CLAUDE_ENV_FILE: target }, sessionId: 'default-session', dir: settingsDir, owner: null })
    assert.deepEqual(result, { written: true, filed: true, reason: 'ok' })
    assert.equal(readSessionSettings('default-session', { dir: settingsDir }).mcp_url, PROD)
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

  it('replaces what an earlier version left behind, a pasted key included', () => {
    // Before 0.46.1 the env file exported the key itself, and before 0.54.0 the settings
    // file held it. A resumed session re-runs the hook on the same files, and nothing of
    // the old content may survive.
    const target = path.join(dir, 'sessionstart-hook-1.sh')
    fs.writeFileSync(target, `export CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN='${OLD_KEY}'\n`)
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(sessionSettingsPath(SESSION, settingsDir), JSON.stringify({ token: OLD_KEY, mcp_url: PROD }), { mode: 0o600 })
    writeSessionEnvCredentials({ env: hookEnv(target), sessionId: SESSION, dir: settingsDir, owner: null })
    writeSessionEnvCredentials({ env: hookEnv(target), sessionId: SESSION, dir: settingsDir, owner: null })
    const written = fs.readFileSync(target, 'utf8')
    assert.ok(!written.includes(OLD_KEY))
    assert.equal(written.split('\n').filter((l) => l.startsWith('export ')).length, 1)
    assert.ok(!fs.readFileSync(sessionSettingsPath(SESSION, settingsDir), 'utf8').includes(OLD_KEY))
  })

  it('still files the settings when Claude Code sets no CLAUDE_ENV_FILE', () => {
    // An older host, or a hook event that does not get one: the listener reads the
    // file by its own conversation id.
    const result = writeSessionEnvCredentials({
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING },
      sessionId: 'no-env-file',
      dir: settingsDir,
      owner: null,
    })
    assert.deepEqual(result, { written: false, filed: true, reason: 'no_env_file' })
    assert.equal(readSessionSettings('no-env-file', { dir: settingsDir }).mcp_url, STAGING)
  })

  it('carries only the startup choice when the settings cannot be filed', () => {
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
  // the resolver there. Proves a Bash tool call reaches the plugin's configured server,
  // and so its browser sign-in for that server, with nothing secret on any argv.
  it("resolves the plugin's own server and the sign-in saved for it, and the hook itself says nothing", () => {
    const home = tmpDir('devspec-session-env-route-')
    const envFile = path.join(home, 'sessionstart-hook-2.sh')
    const base = { PATH: process.env.PATH, HOME: home, USERPROFILE: home }
    const hook = spawnSync(process.execPath, [path.join(HERE, 'session-env-credentials.mjs')], {
      env: {
        ...base,
        CLAUDE_ENV_FILE: envFile,
        CLAUDE_PID: String(process.pid),
        CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
        CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'true',
      },
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION, source: 'startup' }),
      encoding: 'utf8',
    })
    assert.equal(hook.status, 0, hook.stderr)
    assert.equal(hook.stdout, '', 'the sign-in notice is its own hook (devspec-login.mjs session-start)')
    const settingsFile = path.join(home, '.devspec', 'remote-control', 'startup', `${SESSION}.json`)
    assert.equal(mode(settingsFile), 0o600)

    // A saved sign-in for staging and one for production, side by side.
    const authDir = path.join(home, '.devspec', 'claude-code')
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 })
    const login = (tag, resource) => ({
      accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      issuer: 'https://issuer.example', tokenEndpoint: 'https://issuer.example/oauth/token',
      clientId: 'claude-code', resource, loginId: `login-${tag}`, savedAt: new Date().toISOString(),
    })
    fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify({
      version: 1, logins: { [STAGING]: login('staging', STAGING), [PROD]: login('prod', PROD) },
    }), { mode: 0o600 })

    const envText = fs.readFileSync(envFile, 'utf8').trim()
    const resolver = path.join(HERE, 'resolve-mcp-auth.mjs')
    // CONNECT_AT_STARTUP rides in the env file too; it must not hide the filed server.
    const command = `true 2>/dev/null || true && ${envText}\n: && node '${resolver}'`
    assert.ok(!command.includes('oat_'), 'the Bash tool argv carries no credential')
    const call = spawnSync('sh', ['-c', command], { env: base, cwd: home, encoding: 'utf8' })
    assert.equal(call.status, 0, call.stderr)
    const resolved = JSON.parse(call.stdout)
    assert.equal(resolved.mcp_url, STAGING)
    assert.equal(resolved.source, 'login')
    assert.equal(resolved.token, undefined, 'the CLI never prints a token')

    // SessionEnd removes the settings file.
    const end = spawnSync(process.execPath, [path.join(HERE, 'session-env-credentials.mjs'), 'session-end'], {
      env: { ...base, CLAUDE_PID: String(process.pid) },
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: SESSION, reason: 'other' }),
      encoding: 'utf8',
    })
    assert.equal(end.status, 0, end.stderr)
    assert.equal(fs.existsSync(settingsFile), false)
  })
})

describe('where a script finds the settings', () => {
  let settingsDir
  before(() => {
    settingsDir = path.join(tmpDir('devspec-settings-where-'), 'startup')
    writeSessionSettings(SESSION, { mcp_url: STAGING, connect_at_startup: 'false' }, { dir: settingsDir, owner: null })
  })

  it("a hook's own environment wins over the file", () => {
    const settings = pluginSettingsFromEnv(
      { CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: 'https://local/api/mcp', [PLUGIN_SETTINGS_SESSION_VAR]: SESSION },
      { dir: settingsDir },
    )
    assert.equal(settings.mcp_url, 'https://local/api/mcp')
    assert.equal(settings.carried, 'hook_environment')
  })

  it('a Bash tool call reads the file, even though the startup choice is in its environment', () => {
    const settings = pluginSettingsFromEnv(
      { CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'false', [PLUGIN_SETTINGS_SESSION_VAR]: SESSION },
      { dir: settingsDir },
    )
    assert.equal(settings.mcp_url, STAGING)
    assert.equal(settings.carried, 'session_file')
  })

  it('reads nothing for a conversation that has no file', () => {
    assert.equal(pluginSettingsFromEnv({ [PLUGIN_SETTINGS_SESSION_VAR]: 'nobody' }, { dir: settingsDir }), null)
    assert.equal(pluginSettingsFromEnv({}, { dir: settingsDir }), null)
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
    const dead = file(dir, 'dead', { mcp_url: PROD, owner_pid: 111, owner_started: '5' })
    const live = file(dir, 'live', { mcp_url: PROD, owner_pid: 222, owner_started: '7' })
    const reused = file(dir, 'reused', { mcp_url: PROD, owner_pid: 333, owner_started: '8' })
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
    // Files from before 0.46.1 recorded no owner, and held the pasted key.
    const dir = tmpDir('devspec-sweep-unowned-')
    const old = file(dir, 'old', { token: OLD_KEY }, UNOWNED_SETTINGS_MAX_AGE_MS + 1000)
    const young = file(dir, 'young', { mcp_url: PROD, owner_pid: null }, 60_000)
    sweepSessionSettings({ dir, now: NOW, isAlive: () => true, startTimeOf: () => null })
    assert.equal(fs.existsSync(old), false)
    assert.equal(fs.existsSync(young), true)
  })

  it("never removes the starting conversation's own file, or one it cannot read", () => {
    const dir = tmpDir('devspec-sweep-keep-')
    const own = file(dir, SESSION, { mcp_url: PROD, owner_pid: 111 })
    const torn = path.join(dir, 'torn.json')
    fs.writeFileSync(torn, '{"mcp', { mode: 0o600 })
    sweepSessionSettings({ dir, keep: SESSION, now: NOW, isAlive: () => false })
    assert.equal(fs.existsSync(own), true)
    assert.equal(fs.existsSync(torn), true)
  })

  it('SessionEnd removes its own file but not one another live window re-filed', () => {
    const dir = tmpDir('devspec-session-end-')
    writeSessionSettings('mine', { mcp_url: PROD }, { dir, owner: { pid: 500 } })
    assert.equal(removeSessionSettings('mine', { dir, ownerPid: 500, isAlive: () => true }).removed, true)

    writeSessionSettings('resumed', { mcp_url: PROD }, { dir, owner: { pid: 600 } })
    const kept = removeSessionSettings('resumed', { dir, ownerPid: 500, isAlive: () => true })
    assert.deepEqual(kept, { removed: false, reason: 'owned_by_another_process' })
    assert.equal(removeSessionSettings('resumed', { dir, ownerPid: 500, isAlive: () => false }).removed, true)
  })
})
