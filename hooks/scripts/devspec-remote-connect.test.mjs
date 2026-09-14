#!/usr/bin/env node
/**
 * Unit tests for the mechanical connect path (item 5a393e4c).
 * Run: node --test hooks/scripts/devspec-remote-connect.test.mjs
 *
 * The pin walk is the part worth testing hard: it decides which project a folder
 * claims, and the failure that matters is a pin somewhere up the tree — worst of
 * all in `~` — silently claiming every folder underneath it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, describe, it } from 'node:test'
import { armCursorFlag, findProjectPin, withHttpRetry } from './devspec-remote-connect.mjs'

const tmpRoots = []

/** Build a throwaway tree that stands in for a home directory. */
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-pin-'))
  tmpRoots.push(root)
  const home = path.join(root, 'home', 'someone')
  fs.mkdirSync(home, { recursive: true })
  return { root, home }
}

function writePin(dir, projectId) {
  fs.mkdirSync(path.join(dir, '.devspec'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.devspec', 'project.json'),
    JSON.stringify({ project_id: projectId }),
  )
}

after(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe('armCursorFlag', () => {
  // Regression guard: connect shipped printing --from-end unconditionally.
  // devspec-remote-wait.mjs WRITES the new inbox_byte_offset for --from-end, so
  // following the printed command after a reconnect permanently dropped owner
  // mail that arrived while the agent was away.
  it('uses --from-end only for a connection that was just created', () => {
    assert.equal(armCursorFlag({ created: true }), '--from-end')
  })

  it('uses --pending for a reconnect or an already-live connection', () => {
    assert.equal(armCursorFlag({ created: false }), '--pending')
  })

  it('defaults to --pending when the server did not say, since losing mail is worse', () => {
    assert.equal(armCursorFlag({}), '--pending')
    assert.equal(armCursorFlag(), '--pending')
    assert.equal(armCursorFlag({ created: undefined }), '--pending')
  })

  it('does not treat a truthy non-true value as created', () => {
    assert.equal(armCursorFlag({ created: 'yes' }), '--pending')
    assert.equal(armCursorFlag({ created: 1 }), '--pending')
  })
})

/**
 * The pin is normally untracked, so a LINKED WORKTREE carries none — and the
 * implementation contract requires work to happen in one. Reading only the cwd chain
 * left every isolated session unable to name its own project (contract 4.1.0:
 * jurisdiction is a property of the repository, not of the directory).
 */
describe('findProjectPin reaches the repository, not just the directory', () => {
  it('finds a pin held in the main working tree from a linked worktree', () => {
    const { root, home } = makeTree()
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const git = (...args) => spawnSync('git', [
      '-C', repo,
      '-c', 'user.email=test@example.invalid',
      '-c', 'user.name=test',
      '-c', 'commit.gpgsign=false',
      ...args,
    ], { encoding: 'utf8' })
    assert.equal(spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' }).status, 0)
    const seeded = git('commit', '-q', '--allow-empty', '-m', 'seed')
    assert.equal(seeded.status, 0, seeded.stderr)

    fs.mkdirSync(path.join(repo, '.devspec'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, '.devspec', 'project.json'),
      JSON.stringify({ project_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
    )

    const worktree = path.join(root, 'linked')
    const added = git('worktree', 'add', '--detach', worktree)
    assert.equal(added.status, 0, added.stderr)
    assert.ok(!fs.existsSync(path.join(worktree, '.devspec')), 'the linked worktree carries no pin')

    const found = findProjectPin(worktree, { home })
    assert.equal(found?.project_id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  })

  it('still finds nothing when the repository has no pin at all', () => {
    const { root, home } = makeTree()
    const repo = path.join(root, 'bare-ish')
    fs.mkdirSync(repo, { recursive: true })
    assert.equal(spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' }).status, 0)
    assert.equal(findProjectPin(repo, { home }), null)
  })
})

describe('findProjectPin', () => {
  it('finds a pin in the working directory itself', () => {
    const { home } = makeTree()
    const proj = path.join(home, 'code', 'thing')
    fs.mkdirSync(proj, { recursive: true })
    writePin(proj, 'aaaaaaaa-0000-4000-8000-000000000001')

    const found = findProjectPin(proj, { home, root: proj })
    assert.equal(found?.project_id, 'aaaaaaaa-0000-4000-8000-000000000001')
  })

  it('walks up to the repository root and stops there', () => {
    const { home } = makeTree()
    const repo = path.join(home, 'code', 'repo')
    const nested = path.join(repo, 'apps', 'web')
    fs.mkdirSync(nested, { recursive: true })
    writePin(repo, 'bbbbbbbb-0000-4000-8000-000000000002')

    const found = findProjectPin(nested, { home, root: repo })
    assert.equal(found?.project_id, 'bbbbbbbb-0000-4000-8000-000000000002')
  })

  it('prefers the NEAREST pin when several exist', () => {
    const { home } = makeTree()
    const repo = path.join(home, 'code', 'repo')
    const nested = path.join(repo, 'apps', 'web')
    fs.mkdirSync(nested, { recursive: true })
    writePin(repo, 'cccccccc-0000-4000-8000-000000000003')
    writePin(nested, 'dddddddd-0000-4000-8000-000000000004')

    const found = findProjectPin(nested, { home, root: repo })
    assert.equal(found?.project_id, 'dddddddd-0000-4000-8000-000000000004')
  })

  it('does NOT read a pin above the repository root', () => {
    const { home } = makeTree()
    const parent = path.join(home, 'code')
    const repo = path.join(parent, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    writePin(parent, 'eeeeeeee-0000-4000-8000-000000000005')

    assert.equal(findProjectPin(repo, { home, root: repo }), null)
  })

  it('NEVER reads a pin sitting in the home directory', () => {
    // A pin in ~ would claim every folder the user owns.
    const { home } = makeTree()
    const loose = path.join(home, 'scratch')
    fs.mkdirSync(loose, { recursive: true })
    writePin(home, 'ffffffff-0000-4000-8000-000000000006')

    assert.equal(findProjectPin(loose, { home, root: null }), null)
  })

  it('returns null rather than throwing on a malformed pin', () => {
    const { home } = makeTree()
    const proj = path.join(home, 'code', 'broken')
    fs.mkdirSync(path.join(proj, '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(proj, '.devspec', 'project.json'), '{not json')

    assert.equal(findProjectPin(proj, { home, root: proj }), null)
  })

  it('ignores a pin file that carries no project_id', () => {
    const { home } = makeTree()
    const proj = path.join(home, 'code', 'empty')
    fs.mkdirSync(path.join(proj, '.devspec'), { recursive: true })
    fs.writeFileSync(
      path.join(proj, '.devspec', 'project.json'),
      JSON.stringify({ note: 'no id here' }),
    )

    assert.equal(findProjectPin(proj, { home, root: proj }), null)
  })

  it('walks up from a folder outside the home directory without escaping to /', () => {
    // A repo under /tmp or /opt is legitimate; the walk must terminate, not crawl to root.
    const { root } = makeTree()
    const outside = path.join(root, 'opt', 'thing')
    fs.mkdirSync(outside, { recursive: true })
    writePin(outside, '99999999-0000-4000-8000-000000000009')

    const found = findProjectPin(outside, { home: path.join(root, 'home', 'someone'), root: outside })
    assert.equal(found?.project_id, '99999999-0000-4000-8000-000000000009')
  })
})

describe('withHttpRetry — a one-shot connect must ride out a blip', () => {
  const noSleep = async () => {}

  /** The exact error mcp-call throws for the 502 that killed a real connect. */
  const badGateway = () =>
    Object.assign(new Error('MCP HTTP 502: Bad Gateway'), {
      status: 502, serverCode: null, retryable: null, credentialType: null,
    })

  it('retries a body-less 502 and returns the eventual success', async () => {
    let calls = 0
    const result = await withHttpRetry(
      async () => {
        calls++
        if (calls < 3) throw badGateway()
        return { ok: true }
      },
      { sleepFn: noSleep },
    )
    assert.deepEqual(result, { ok: true })
    assert.equal(calls, 3)
  })

  it('retries what the server itself called retryable', async () => {
    let calls = 0
    await withHttpRetry(
      async () => {
        calls++
        if (calls < 2) {
          throw Object.assign(new Error('MCP HTTP 503: unavailable'), {
            status: 503, serverCode: 'auth_validation_unavailable', retryable: true,
          })
        }
        return 'ok'
      },
      { sleepFn: noSleep },
    )
    assert.equal(calls, 2)
  })

  it('does NOT retry a credential the server rejected — one attempt, error surfaces', async () => {
    let calls = 0
    await assert.rejects(
      withHttpRetry(
        async () => {
          calls++
          throw Object.assign(new Error('MCP HTTP 401: Invalid or revoked API token'), {
            status: 401, serverCode: 'invalid_api_token', retryable: false,
          })
        },
        { sleepFn: noSleep },
      ),
      /Invalid or revoked API token/,
    )
    assert.equal(calls, 1, 'a dead token must not be hammered')
  })

  it('gives up after the bounded number of attempts and rethrows the last error', async () => {
    let calls = 0
    await assert.rejects(
      withHttpRetry(
        async () => { calls++; throw badGateway() },
        { sleepFn: noSleep },
      ),
      /MCP HTTP 502/,
    )
    assert.equal(calls, 3, 'bounded, not infinite')
  })

  it('never retries a deliberate abort, whatever the status', async () => {
    let calls = 0
    await assert.rejects(
      withHttpRetry(
        async () => {
          calls++
          throw Object.assign(new Error('MCP request aborted: owner_gone'), {
            code: 'owner_gone', status: 503,
          })
        },
        { sleepFn: noSleep },
      ),
      /owner_gone/,
    )
    assert.equal(calls, 1)
  })
})
