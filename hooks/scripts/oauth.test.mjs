/**
 * Browser sign-in, OAuth half (item 47f0dbdf): discovery, PKCE, the loopback listener and
 * the copy-a-code path, against a local stand-in for DevSpec and Clerk whose token
 * endpoint pays out only for the right PKCE verifier.
 * Run: node --test hooks/scripts/oauth.test.mjs
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  authorizationUrl,
  beginCopyCodeSignIn,
  browserCanReachThisMachine,
  CLAUDE_CODE_CLIENT_IDS,
  clientIdFor,
  completeCopyCodeSignIn,
  discoverSignIn,
  environmentLabel,
  normalizeResource,
  openInBrowser,
  refreshTokens,
  signInCodePageUrl,
  SignInEndedError,
  startLoopbackSignIn,
} from './oauth.mjs'
import { startFakeDevspec } from './fixtures/fake-devspec-sign-in.mjs'

let fake
before(async () => { fake = await startFakeDevspec() })
after(() => fake.close())

const discovery = () => discoverSignIn(fake.mcpUrl)

describe('discovery', () => {
  it('follows DevSpec to its sign-in server', async () => {
    const found = await discovery()
    assert.equal(found.resource, fake.mcpUrl)
    assert.equal(found.issuer, fake.issuer)
    assert.equal(found.tokenEndpoint, `${fake.base}/oauth/token`)
    assert.equal(found.revocationEndpoint, `${fake.base}/oauth/revoke`)
  })

  it('keys a server by origin and path, ignoring the query Claude Code adds', async () => {
    assert.equal(normalizeResource('https://api.devspec.ai/api/mcp/?model_tools=a,b'), 'https://api.devspec.ai/api/mcp')
    const found = await discoverSignIn(`${fake.mcpUrl}?model_tools=heartbeat_connection`)
    assert.equal(found.resource, fake.mcpUrl)
  })

  it('refuses metadata for a different address, and a server without browser sign-in', async () => {
    fake.metadataResource = 'https://elsewhere.test/api/mcp'
    try {
      await assert.rejects(discovery(), /different address/)
    } finally {
      fake.metadataResource = null
    }
    await assert.rejects(discoverSignIn(`${fake.base}/other/mcp`), /does not offer browser sign-in yet/)
  })
})

describe("Claude Code's own sign-in app", () => {
  it('has one client per DevSpec sign-in server, keyed by issuer, and refuses any other', () => {
    assert.equal(clientIdFor('https://clerk.devspec.ai'), 'fjxmjlWH4Nzq54hU')
    assert.equal(clientIdFor('https://apt-hare-75.clerk.accounts.dev'), '0xLi8PElmOG3ndz0')
    assert.equal(clientIdFor('https://apt-hare-75.clerk.accounts.dev/'), '0xLi8PElmOG3ndz0')
    assert.equal(Object.keys(CLAUDE_CODE_CLIENT_IDS).length, 2)
    assert.throws(() => clientIdFor('https://attacker.test'), /does not know how to sign in/)
  })

  it('names the server and its copy-a-code page by deployment', () => {
    assert.equal(environmentLabel('https://api.devspec.ai/api/mcp'), 'production')
    assert.equal(environmentLabel('https://api.devspecstaging.com/api/mcp?model_tools=x'), 'staging')
    assert.equal(environmentLabel('http://localhost:3000/api/mcp'), 'http://localhost:3000')
    assert.equal(signInCodePageUrl('https://api.devspec.ai/api/mcp'), 'https://app.devspec.ai/oauth-code')
    assert.equal(signInCodePageUrl('https://api.devspecstaging.com/api/mcp'), 'https://app.devspecstaging.com/oauth-code')
    assert.equal(signInCodePageUrl('http://localhost:3000/api/mcp'), 'http://localhost:3000/oauth-code')
  })
})

describe('loopback sign-in', () => {
  it('asks for DevSpec access and renewal with S256 PKCE, for this exact server', async () => {
    const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: 'claude-client' })
    try {
      const request = new URL(pending.url)
      assert.equal(request.searchParams.get('response_type'), 'code')
      assert.equal(request.searchParams.get('client_id'), 'claude-client')
      assert.equal(request.searchParams.get('scope'), 'devspec offline_access')
      assert.equal(request.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(request.searchParams.get('resource'), fake.mcpUrl)
      assert.match(request.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      assert.equal(request.searchParams.get('redirect_uri'), pending.redirectUri)
    } finally {
      pending.cancel()
    }
  })

  it('brings the approval back through the browser, and only with the matching state', async () => {
    const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: 'claude-client' })
    // A callback this Claude Code did not start is refused, and does not end the sign-in.
    const forged = new URL(pending.redirectUri)
    forged.searchParams.set('code', 'stolen')
    forged.searchParams.set('state', 'someone-elses')
    assert.equal((await fetch(forged)).status, 400)

    // The person presses Allow: the browser follows the redirect to the listener.
    const page = await fetch(pending.url)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /Signed in to DevSpec/)
    assert.match(html, /go back to Claude Code/)
    assert.match(html, /Restart Claude Code to finish connecting\./)
    assert.match(html, /color-scheme:light dark/)
    assert.match(html, /@media \(prefers-color-scheme:dark\)/)
    assert.match(html, /logo-icon\.png/)
    const tokens = await pending.done
    assert.match(tokens.accessToken, /^oat_/)
    assert.match(tokens.refreshToken, /^rt_/)
    assert.ok(tokens.expiresAt > tokens.issuedAt)
    const exchange = fake.tokenRequests.at(-1)
    assert.equal(exchange.grant_type, 'authorization_code')
    assert.equal(exchange.resource, fake.mcpUrl)
    assert.equal(exchange.client_id, 'claude-client')
    assert.ok(exchange.code_verifier, 'the verifier goes only to the token endpoint')
    assert.equal(new URL(pending.url).searchParams.get('code_verifier'), null)
    await assert.rejects(fetch(pending.redirectUri), 'the listener is gone once the sign-in finishes')
  })

  it('Deny in the browser ends the sign-in plainly', async () => {
    const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: 'claude-client' })
    const outcome = assert.rejects(pending.done, /canceled in the browser/)
    const page = await fetch(`${pending.url}&deny=1`)
    assert.match(await page.text(), /Nothing was connected/)
    await outcome
  })

  it('refuses an approval returned by a different sign-in server (RFC 9207)', async () => {
    const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: 'claude-client' })
    const outcome = assert.rejects(pending.done, /different server/)
    const back = new URL(pending.redirectUri)
    back.searchParams.set('code', 'code-mixup')
    back.searchParams.set('state', new URL(pending.url).searchParams.get('state'))
    back.searchParams.set('iss', 'https://attacker.test')
    assert.equal((await fetch(back)).status, 400)
    await outcome
  })

  it('closes its listener by itself when nobody answers', async () => {
    const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: 'claude-client', waitMs: 20 })
    await assert.rejects(pending.done, /timed out/)
    await assert.rejects(fetch(pending.redirectUri))
  })

  it('a code exchanged with the wrong verifier pays nothing out', async () => {
    const found = await discovery()
    const request = authorizationUrl({
      discovery: found, clientId: 'claude-client', redirectUri: `${fake.base}/oauth-code`, state: 's', challenge: 'not-the-hash',
    })
    const shown = await (await fetch(request)).text()
    const code = shown.slice(0, shown.lastIndexOf('#'))
    await assert.rejects(
      completeCopyCodeSignIn({ discovery: found, clientId: 'claude-client', pasted: `${code}#s`, state: 's', verifier: 'wrong', redirectUri: `${fake.base}/oauth-code` }),
      SignInEndedError,
    )
  })
})

describe('copy-a-code sign-in, for a machine the browser cannot reach', () => {
  it("returns through DevSpec's own page, and accepts only the code from this sign-in", async () => {
    const found = await discovery()
    const codePageUrl = `${fake.base}/oauth-code`
    const flow = beginCopyCodeSignIn({ discovery: found, clientId: 'claude-client', codePageUrl })
    assert.equal(new URL(flow.url).searchParams.get('redirect_uri'), codePageUrl)
    // The person approves; DevSpec's page shows code#state to copy.
    const shown = await (await fetch(flow.url)).text()
    assert.match(shown, /#/)
    const finish = (pasted) => completeCopyCodeSignIn({ discovery: found, clientId: 'claude-client', pasted, ...flow })
    const code = shown.slice(0, shown.lastIndexOf('#'))
    await assert.rejects(finish(`${code}#not-this-sign-in`), /not from this sign-in/)
    await assert.rejects(finish(code), /not from this sign-in/)
    const tokens = await finish(`  ${shown}\n`)
    assert.match(tokens.accessToken, /^oat_/)
    assert.equal(fake.tokenRequests.at(-1).redirect_uri, codePageUrl)
  })

  it('is chosen by itself in any SSH session', () => {
    assert.equal(browserCanReachThisMachine({}), true)
    assert.equal(browserCanReachThisMachine({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }), false)
    assert.equal(browserCanReachThisMachine({ SSH_TTY: '/dev/pts/1' }), false)
    assert.equal(browserCanReachThisMachine({ SSH_CLIENT: '1.2.3.4 5 22' }), false)
  })
})

describe('renewal', () => {
  it('rotates the renewal key, and a spent or revoked key ends the sign-in', async () => {
    const found = await discovery()
    const seeded = fake.mint('renewal')
    const renewed = await refreshTokens({ tokenEndpoint: found.tokenEndpoint, clientId: 'claude-client', refreshToken: seeded.refreshToken, resource: found.resource })
    assert.notEqual(renewed.refreshToken, seeded.refreshToken)
    await assert.rejects(
      refreshTokens({ tokenEndpoint: found.tokenEndpoint, clientId: 'claude-client', refreshToken: seeded.refreshToken, resource: found.resource }),
      SignInEndedError,
      'a renewal key used twice is the end of the sign-in',
    )
  })
})

describe('opening the browser', () => {
  it('runs the opener directly, never through a shell, and survives a missing one', () => {
    const calls = []
    const spawnImpl = (cmd, args, options) => {
      calls.push({ cmd, args, options })
      return { on() {}, unref() {} }
    }
    const url = 'https://clerk.example/oauth/authorize?state=a&b=$(touch /tmp/x)'
    openInBrowser(url, { platform: 'linux', spawnImpl })
    openInBrowser(url, { platform: 'darwin', spawnImpl })
    openInBrowser(url, { platform: 'win32', spawnImpl })
    assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
      ['xdg-open', [url]],
      ['open', [url]],
      ['rundll32', ['url.dll,FileProtocolHandler', url]],
    ])
    assert.ok(calls.every((c) => c.options.detached === true && c.options.shell === undefined))
    assert.doesNotThrow(() => openInBrowser(url, { spawnImpl: () => { throw new Error('ENOENT') } }))
  })
})
