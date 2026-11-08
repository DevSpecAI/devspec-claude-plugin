/**
 * Signing Claude Code's DevSpec plugin in and out (item 47f0dbdf), end to end against a
 * local stand-in for DevSpec and Clerk: the login command's two steps, the copy-a-code
 * path, logout, status, the session-start notice, and the plain sentence for a refused
 * sign-in.
 * Run: node --test hooks/scripts/devspec-login.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { loginState, saveLogin } from './auth-store.mjs'
import {
  completeLogin,
  logout,
  pendingSignInPath,
  runBrowserListener,
  sessionStartNotice,
  startLogin,
  status,
  waitForLogin,
} from './devspec-login.mjs'
import { discoverSignIn } from './oauth.mjs'
import { agentsSettingsUrl, devspecAppOrigin, refusedCredentialMessage } from './sign-in-notices.mjs'
import { startFakeDevspec } from './fixtures/fake-devspec-sign-in.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'devspec-login.mjs')
const HOUR = 60 * 60 * 1000

let fake
let clientIds
before(async () => {
  fake = await startFakeDevspec({ connectedAs: 'Ada Lovelace' })
  clientIds = { [fake.issuer]: 'claude-client' }
})
after(() => fake.close())

const realHome = process.env.HOME
let sandbox
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-login-'))
  process.env.HOME = sandbox
})
afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const settingFor = (url) => ({ CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: url })
const label = () => fake.base

async function signedIn(tag, { issuedAt = Date.now() } = {}) {
  const minted = fake.mint(tag)
  await saveLogin({
    endpoint: fake.mcpUrl,
    tokens: { ...minted, issuedAt, expiresAt: issuedAt + 24 * HOUR },
    issuer: fake.issuer,
    tokenEndpoint: `${fake.base}/oauth/token`,
    revocationEndpoint: `${fake.base}/oauth/revoke`,
    clientId: 'claude-client',
    resource: fake.mcpUrl,
  })
  return minted
}

describe('login through the browser', () => {
  it('opens the approval page, prints its link, and finishes when the browser comes back', async () => {
    const opened = []
    const lines = await startLogin({ env: settingFor(fake.mcpUrl) }, { clientIds, open: (url) => opened.push(url) })
    const url = lines.find((line) => line.startsWith('http'))
    assert.ok(url, 'the link is always printed')
    assert.deepEqual(opened, [url], 'and opened, once')
    assert.match(lines[0], new RegExp(`Approve DevSpec \\(${label().replaceAll('.', '\\.')}\\) in your browser`))
    assert.equal(new URL(url).searchParams.get('client_id'), 'claude-client')
    assert.equal(new URL(url).searchParams.get('resource'), fake.mcpUrl)

    // The detached listener holds the port; the person presses Allow.
    const page = await fetch(url)
    assert.equal(page.status, 200)
    const result = await waitForLogin({ limitMs: 10_000, pollMs: 25 })
    assert.equal(result.ok, true, result.message)
    assert.equal(
      result.message,
      `Signed in to DevSpec (${label()}) as Ada Lovelace. Start a new Claude Code session to use it everywhere. ` +
        "To use it in this session, open /mcp, choose devspec and Reconnect for Claude Code's DevSpec tools, " +
        'and run /devspec:devspec.remote for remote control.',
    )
    const state = loginState(fake.mcpUrl)
    assert.equal(state.kind, 'active')
    assert.equal(state.login.signedInAs, 'Ada Lovelace')
    assert.equal(state.login.clientId, 'claude-client')
    assert.equal(fake.verifications.at(-1).bearer, state.login.accessToken, 'verified at that same server before saving')
    assert.match(fake.verifications.at(-1).plugin, /^claude_code\//)
    assert.equal(fs.existsSync(pendingSignInPath()), false, 'nothing waiting afterwards')
  })

  it('says how it went when the person presses Deny', async () => {
    const lines = await startLogin({ env: settingFor(fake.mcpUrl) }, { clientIds, open: () => {} })
    const url = lines.find((line) => line.startsWith('http'))
    await fetch(`${url}&deny=1`)
    const result = await waitForLogin({ limitMs: 10_000, pollMs: 25 })
    assert.equal(result.ok, false)
    assert.equal(result.message, 'DevSpec sign-in did not finish: Sign-in was canceled in the browser.')
    assert.equal(loginState(fake.mcpUrl).kind, 'none')
  })

  it('saves nothing DevSpec will not accept', async () => {
    const found = await discoverSignIn(fake.mcpUrl)
    const lines = []
    const outcome = runBrowserListener(
      { endpoint: fake.mcpUrl, discovery: found, clientId: 'claude-client' },
      {
        report: (line) => lines.push(JSON.parse(line)),
        call: async () => {
          throw Object.assign(new Error('MCP HTTP 401: {"error":"Invalid or revoked API token","code":"invalid_api_token","retryable":false}'), { status: 401, serverCode: 'invalid_api_token' })
        },
      },
    )
    while (!lines.length) await new Promise((resolve) => setTimeout(resolve, 10))
    await fetch(lines[0].url)
    const result = await outcome
    assert.equal(result.ok, false)
    assert.match(result.message, /refused your saved sign-in/)
    assert.equal(loginState(fake.mcpUrl).kind, 'none')
  })

  it('stops waiting by itself, and says how to try again', async () => {
    const found = await discoverSignIn(fake.mcpUrl)
    const result = await runBrowserListener(
      { endpoint: fake.mcpUrl, discovery: found, clientId: 'claude-client' },
      { report: () => {}, waitMs: 30 },
    )
    assert.equal(result.ok, false)
    assert.match(result.message, /timed out waiting for the browser\. Run \/devspec:devspec\.login to try again\./)
  })

  it('with nothing started, --wait says so', async () => {
    const result = await waitForLogin({ limitMs: 100, pollMs: 10 })
    assert.equal(result.ok, false)
    assert.equal(result.message, 'No browser sign-in is waiting. Run /devspec:devspec.login to start one.')
  })

  it('refuses while DEVSPEC_MCP_TOKEN is set, because that token would win anyway', async () => {
    await assert.rejects(
      startLogin({ env: { ...settingFor(fake.mcpUrl), DEVSPEC_MCP_TOKEN: 'dvs_env' } }, { clientIds, open: () => assert.fail('must not open') }),
      /DEVSPEC_MCP_TOKEN is set in this environment, and it always takes precedence over a browser sign-in/,
    )
  })

  it('says plainly when the server does not offer browser sign-in', async () => {
    await assert.rejects(
      startLogin({ env: settingFor(`${fake.base}/not-mcp`) }, { clientIds, open: () => {} }),
      /DevSpec sign-in is unavailable: This DevSpec server \(http:\/\/127\.0\.0\.1:\d+\) does not offer browser sign-in yet\./,
    )
  })
})

describe('login with a code, for a machine the browser cannot reach', () => {
  it('prints the link, then accepts only the code from this sign-in, once', async () => {
    const opened = []
    const env = { ...settingFor(fake.mcpUrl), SSH_CONNECTION: '10.0.0.2 5555 10.0.0.1 22' }
    const lines = await startLogin({ env }, { clientIds, open: (url) => opened.push(url) })
    assert.deepEqual(opened, [], 'over SSH the browser is on another machine: only the link')
    const url = lines.find((line) => line.startsWith('http'))
    assert.match(lines[0], /copy the code the page shows/)
    // Copy-a-code returns to DevSpec's own page for that server.
    assert.equal(new URL(url).searchParams.get('redirect_uri'), `${fake.base}/oauth-code`)
    assert.equal(fs.statSync(pendingSignInPath()).mode & 0o777, 0o600)

    const shown = await (await fetch(url)).text()
    const code = shown.slice(0, shown.lastIndexOf('#'))
    await assert.rejects(completeLogin(`${code}#someone-elses`, { env }, {}), /not from this sign-in/)
    const message = await completeLogin(` ${shown} `, { env })
    assert.match(message, /^Signed in to DevSpec \(http:\/\/127\.0\.0\.1:\d+\) as Ada Lovelace\./)
    assert.equal(loginState(fake.mcpUrl).kind, 'active')
    await assert.rejects(completeLogin(shown, { env }), /No sign-in is waiting for a code/)
  })

  it('a --code sign-in expires after ten minutes', async () => {
    await startLogin({ env: settingFor(fake.mcpUrl), code: true }, { clientIds, open: () => {} })
    const pending = JSON.parse(fs.readFileSync(pendingSignInPath(), 'utf8'))
    fs.writeFileSync(pendingSignInPath(), JSON.stringify({ ...pending, expiresAt: new Date(Date.now() - 1000).toISOString() }))
    await assert.rejects(completeLogin('x#y', { env: {} }), /That sign-in has expired/)
  })
})

describe('logout and status', () => {
  it('signs out of the configured server only, and cancels the grant at the sign-in server', async () => {
    const minted = await signedIn('to-revoke')
    await saveLogin({
      endpoint: 'https://api.devspecstaging.com/api/mcp',
      tokens: { accessToken: 'oat_staging', refreshToken: 'rt_staging', issuedAt: Date.now(), expiresAt: Date.now() + HOUR },
      issuer: 'https://issuer.test', tokenEndpoint: 'https://issuer.test/t', clientId: 'c', resource: 'https://api.devspecstaging.com/api/mcp',
    })
    const said = await logout({ env: settingFor(fake.mcpUrl) })
    assert.match(said, new RegExp(`^Signed out of DevSpec \\(${label().replaceAll('.', '\\.')}\\)\\.`))
    assert.equal(loginState(fake.mcpUrl).kind, 'none')
    assert.equal(loginState('https://api.devspecstaging.com/api/mcp').kind, 'active')
    assert.deepEqual(fake.revoked.at(-1), { token: minted.refreshToken, token_type_hint: 'refresh_token', client_id: 'claude-client' })
    assert.equal(await logout({ env: settingFor(fake.mcpUrl) }), `Claude Code was not signed in to DevSpec (${label()}).`)
  })

  it('status names the server and how the plugin is signed in', async () => {
    assert.equal(status({ env: settingFor(fake.mcpUrl) }), `Claude Code is not signed in to DevSpec (${label()}). Run /devspec:devspec.login to sign in through your browser.`)
    await signedIn('status')
    assert.equal(status({ env: settingFor(fake.mcpUrl) }), `DevSpec (${label()}): signed in through the browser · ${fake.mcpUrl}`)
    const withEnv = status({ env: { ...settingFor(fake.mcpUrl), DEVSPEC_MCP_TOKEN: 'dvs_env' } })
    assert.match(withEnv, /using the token in DEVSPEC_MCP_TOKEN/)
    assert.match(withEnv, /DEVSPEC_MCP_TOKEN is set, so DevSpec's background features/)
  })
})

describe('session start says plainly when the saved sign-in does not work', () => {
  it('when there is none for the chosen server', async () => {
    assert.equal(
      await sessionStartNotice({ env: settingFor('https://api.devspecstaging.com/api/mcp') }),
      'Claude Code is not signed in to DevSpec (staging). Run /devspec:devspec.login to sign in through your browser.',
    )
  })

  it('nothing when DevSpec accepts it', async () => {
    const minted = await signedIn('accepted')
    assert.equal(await sessionStartNotice({ env: settingFor(fake.mcpUrl) }), null)
    assert.equal(fake.probes.at(-1), minted.accessToken)
  })

  it('when the person disconnected Claude Code on the Agent setup page', async () => {
    const minted = await signedIn('disconnected')
    fake.signedOut.add(minted.accessToken)
    assert.equal(
      await sessionStartNotice({ env: settingFor(fake.mcpUrl) }),
      'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings. Then run /devspec:devspec.login.',
    )
  })

  it('when DevSpec refused to renew it', async () => {
    const minted = await signedIn('spent', { issuedAt: Date.now() - 20 * HOUR })
    // Spend the renewal key elsewhere first, as a second machine with a copied file would.
    await fetch(`${fake.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: minted.refreshToken, client_id: 'claude-client' }).toString(),
    })
    const notice = await sessionStartNotice({ env: settingFor(fake.mcpUrl) })
    assert.match(notice, /^Your DevSpec sign-in \(http:\/\/127\.0\.0\.1:\d+\) has ended, for example because Claude Code was disconnected on http:\/\/127\.0\.0\.1:\d+\/settings\/agents\. Run \/devspec:devspec\.login to sign in again\.$/)
  })

  it('stays quiet offline: no answer is not a refused sign-in', async () => {
    await saveLogin({
      endpoint: 'http://127.0.0.1:9/api/mcp',
      tokens: { accessToken: 'oat_offline', refreshToken: 'rt_offline', issuedAt: Date.now(), expiresAt: Date.now() + 24 * HOUR },
      issuer: 'https://issuer.test', tokenEndpoint: 'https://issuer.test/t', clientId: 'c', resource: 'http://127.0.0.1:9/api/mcp',
    })
    assert.equal(await sessionStartNotice({ env: settingFor('http://127.0.0.1:9/api/mcp') }), null)
  })

  it('runs as a SessionStart hook: a message for the person and context for Claude', () => {
    const run = spawnSync(process.execPath, [SCRIPT, 'session-start'], {
      env: { PATH: process.env.PATH, HOME: sandbox, ...settingFor('https://api.devspecstaging.com/api/mcp') },
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }),
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    const out = JSON.parse(run.stdout)
    assert.equal(out.systemMessage, 'DevSpec: Claude Code is not signed in to DevSpec (staging). Run /devspec:devspec.login to sign in through your browser.')
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(out.hookSpecificOutput.additionalContext, /\/devspec:devspec\.login/)
    const compacted = spawnSync(process.execPath, [SCRIPT, 'session-start'], {
      env: { PATH: process.env.PATH, HOME: sandbox },
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'compact' }),
      encoding: 'utf8',
    })
    assert.equal(compacted.stdout, '', 'not repeated after compaction')
  })
})

describe('the command line', () => {
  it('login refuses while DEVSPEC_MCP_TOKEN is set, with how to remove it', () => {
    const run = spawnSync(process.execPath, [SCRIPT, 'login'], {
      env: { PATH: process.env.PATH, HOME: sandbox, DEVSPEC_MCP_TOKEN: 'dvs_env' },
      encoding: 'utf8',
    })
    assert.equal(run.status, 1)
    assert.match(run.stdout, /^DEVSPEC_MCP_TOKEN is set in this environment/)
    assert.match(run.stdout, /unset DEVSPEC_MCP_TOKEN|Environment Variables/)
    assert.doesNotMatch(run.stdout, /dvs_env/)
  })

  it('login says when this version does not know the sign-in server', async () => {
    // Asynchronously: the stand-in server runs in this process and must stay free to answer.
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, 'login'], { env: { PATH: process.env.PATH, HOME: sandbox, ...settingFor(fake.mcpUrl) } })
      let stdout = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.on('close', (status) => resolve({ status, stdout }))
    })
    assert.equal(run.status, 1)
    assert.match(run.stdout, /does not know how to sign in to http:\/\/127\.0\.0\.1:\d+\. Update the plugin/)
  })
})

describe('a refused sign-in, in plain words', () => {
  const refused = (code, error) => Object.assign(
    new Error(`MCP HTTP 401: ${JSON.stringify({ error, code, retryable: false })}`),
    { status: 401, serverCode: code },
  )

  it("DevSpec's own sentence for a disconnected tool, then what to run", () => {
    assert.equal(
      refusedCredentialMessage(refused('signed_out', 'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.')),
      'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings. Then run /devspec:devspec.login.',
    )
    assert.match(refusedCredentialMessage({ serverCode: 'signed_out', message: 'MCP HTTP 401: truncated {' }), /Then run \/devspec:devspec\.login\.$/)
  })

  it('an invalid token, for a sign-in and for DEVSPEC_MCP_TOKEN', () => {
    assert.equal(
      refusedCredentialMessage(refused('invalid_api_token', 'Invalid or revoked API token'), { endpoint: 'https://api.devspecstaging.com/api/mcp' }),
      'DevSpec refused your saved sign-in (staging). Run /devspec:devspec.login to sign in again.',
    )
    assert.match(refusedCredentialMessage(refused('invalid_api_token', 'x'), { source: 'env' }), /refused the token in DEVSPEC_MCP_TOKEN/)
  })

  it('nothing for failures that are not a verdict on the sign-in', () => {
    assert.equal(refusedCredentialMessage(Object.assign(new Error('MCP HTTP 401: Unauthorized'), { status: 401 })), null)
    assert.equal(refusedCredentialMessage(Object.assign(new Error('MCP HTTP 503'), { status: 503, serverCode: 'auth_validation_unavailable' })), null)
    assert.equal(refusedCredentialMessage(new Error('fetch failed')), null)
  })

  it('links the Agent setup page on the deployment in use', () => {
    assert.equal(devspecAppOrigin('https://api.devspec.ai/api/mcp'), 'https://app.devspec.ai')
    assert.equal(devspecAppOrigin('https://api.devspecstaging.com/api/mcp'), 'https://app.devspecstaging.com')
    assert.equal(devspecAppOrigin('http://localhost:3000/api/mcp'), 'http://localhost:3000')
    assert.equal(devspecAppOrigin('not a url'), 'https://app.devspec.ai')
    assert.equal(agentsSettingsUrl('https://api.devspecstaging.com/api/mcp'), 'https://app.devspecstaging.com/settings/agents')
  })
})
