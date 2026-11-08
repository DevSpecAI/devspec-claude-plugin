/**
 * A sign-in DevSpec refuses is never failed silently (item 47f0dbdf). Remote control says
 * so when it connects, and a running connection stands down and tells the model once,
 * through its wake reader, so the person hears what to run.
 * Run: node --test hooks/scripts/signed-out.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { connect, ConnectError } from './devspec-remote-connect.mjs'
import { startFakeDevspec } from './fixtures/fake-devspec-sign-in.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONNECTION = '5f0e8c4a-1b2c-4d3e-8f90-0a1b2c3d4e5f'
const DISCONNECTED = 'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.'
const SAID = `${DISCONNECTED} Then run /devspec:devspec.login.`

let fake
const tmp = []
before(async () => { fake = await startFakeDevspec() })
after(async () => {
  await fake.close()
  for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true })
})
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmp.push(dir)
  return dir
}

describe('Remote, when DevSpec refuses the sign-in', () => {
  it('connecting says DevSpec\'s own sentence and what to run, and adopts nothing', async () => {
    const home = tmpDir('devspec-signed-out-connect-')
    let wrote = false
    const refused = Object.assign(new Error(`MCP HTTP 401: ${JSON.stringify({ error: DISCONNECTED, code: 'signed_out', retryable: false })}`), { status: 401, serverCode: 'signed_out', retryable: false })
    const attempt = connect({ cwd: home, localId: 'conv-signed-out', noPoller: true, env: {} }, {
      projectHome: home,
      resolveAuth: async () => ({ ok: true, token: 'oat_disconnected', mcp_url: fake.mcpUrl, source: 'login', principal: 'p' }),
      writeState: async () => { wrote = true; return {} },
      callTool: async () => { throw refused },
      onRetryMessage: () => {},
    })
    await assert.rejects(attempt, (err) => err instanceof ConnectError && err.message === SAID && err.reason === 'auth')
    assert.equal(wrote, false)
  })

  it('connecting with no sign-in says to sign in, before any request', async () => {
    const home = tmpDir('devspec-signed-out-none-')
    let called = false
    const attempt = connect({ cwd: home, localId: 'conv-none', noPoller: true, env: {} }, {
      projectHome: home,
      resolveAuth: async () => ({ ok: false, mcp_url: 'https://api.devspecstaging.com/api/mcp', error: 'Claude Code is not signed in to DevSpec (staging). Run /devspec:devspec.login to sign in through your browser.' }),
      callTool: async () => { called = true },
    })
    await assert.rejects(attempt, /^ConnectError: Claude Code is not signed in to DevSpec \(staging\)\. Run \/devspec:devspec\.login/)
    assert.equal(called, false)
  })
})

describe('a running connection whose sign-in DevSpec refuses', () => {
  it('stands down, and its wake reader tells the model once, in plain words', async () => {
    const home = tmpDir('devspec-signed-out-poll-')
    const dir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(dir, { recursive: true })
    const minted = fake.mint('disconnected-later')
    fake.signedOut.add(minted.accessToken)
    // A connection made with DEVSPEC_MCP_TOKEN keeps its recorded token, so this needs no
    // login file; a browser sign-in is refused by DevSpec the same way.
    const state = {
      enabled: true, connection_id: CONNECTION, session_id: null, local_id: 'conv-poll', owner_pid: process.pid,
      mcp_url: fake.mcpUrl, auth_source: 'env', token: minted.accessToken, cwd: home,
    }
    fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify(state), { mode: 0o600 })
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home }

    const wait = spawn(process.execPath, [path.join(HERE, 'devspec-remote-wait.mjs'), '--connection-id', CONNECTION, '--owner-pid', String(process.pid), '--stream', '--from-end', '--poll-ms', '20'], { env })
    let heard = ''
    wait.stdout.on('data', (chunk) => { heard += chunk })
    const waitClosed = new Promise((resolve) => wait.on('close', resolve))
    await new Promise((resolve) => setTimeout(resolve, 300))

    const poller = spawn(process.execPath, [path.join(HERE, 'devspec-remote-poll.mjs'), '--connection-id', CONNECTION, '--owner-pid', String(process.pid)], { env })
    let pollerErr = ''
    poller.stderr.on('data', (chunk) => { pollerErr += chunk })
    const pollerCode = await new Promise((resolve) => {
      const timer = setTimeout(() => { poller.kill('SIGKILL'); resolve('timeout') }, 20_000)
      poller.on('close', (code) => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(pollerCode, 1, pollerErr)
    const after = JSON.parse(fs.readFileSync(path.join(dir, `${CONNECTION}.json`), 'utf8'))
    assert.equal(after.enabled, false)
    assert.equal(after.end_reason, 'signed_out')
    assert.equal(after.ended_from_ui, false, 'not an End by a person: signing in again and reconnecting is fine')
    assert.equal(after.end_message, SAID)

    const timer = setTimeout(() => wait.kill('SIGKILL'), 5_000)
    await waitClosed
    clearTimeout(timer)
    const events = heard.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(events, [{ type: 'session_ended', reason: 'signed_out', recoverable: true, connection_id: CONNECTION, message: SAID }])
  })
})
