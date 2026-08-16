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
import { after, describe, it } from 'node:test'
import { findProjectPin } from './devspec-remote-connect.mjs'

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
