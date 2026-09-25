/**
 * Every DevSpec tool is named in BOTH the forms Claude Code can deliver it under
 * (item ddc40cc8).
 *
 *   mcp__plugin_devspec_devspec__<verb>   this plugin's own server
 *   mcp__devspec__<verb>                  a server configured by hand as `devspec`
 *
 * Until this existed, every hook matcher, allow-list and script compared against
 * the second form only. On a plain plugin install the claim, release and reply
 * hooks therefore never ran, and the allow-lists granted nothing — silently. These
 * checks DISCOVER what they check (every allow-list in commands/ and skills/, every
 * matcher in hooks.json, every hook script), so a new list or hook cannot opt out
 * by being forgotten.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { devspecToolVerb, devspecToolNames } from './devspec-tool-name.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PLUGIN = 'mcp__plugin_devspec_devspec__'
const HAND = 'mcp__devspec__'

function markdownFiles() {
  const out = []
  for (const dir of ['commands', 'skills']) {
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (entry.name.endsWith('.md')) out.push(p)
      }
    }
    walk(path.join(root, dir))
  }
  return out
}

function allowLists() {
  const lists = []
  for (const file of markdownFiles()) {
    const match = /^allowed-tools:(.*)$/m.exec(fs.readFileSync(file, 'utf8'))
    if (match) lists.push({ file: path.relative(root, file), tools: match[1].split(',').map((t) => t.trim()).filter(Boolean) })
  }
  return lists
}

describe('devspecToolVerb', () => {
  it('reads the verb from either name, and nothing else', () => {
    assert.equal(devspecToolVerb(`${PLUGIN}claim_work_item`), 'claim_work_item')
    assert.equal(devspecToolVerb(`${HAND}claim_work_item`), 'claim_work_item')
    assert.equal(devspecToolVerb('mcp__plugin_other_devspec__claim_work_item'), null)
    assert.equal(devspecToolVerb('mcp__supabase__execute_sql'), null)
    assert.equal(devspecToolVerb('Bash'), null)
    assert.equal(devspecToolVerb(undefined), null)
  })

  it('names both forms of a verb', () => {
    assert.deepEqual(devspecToolNames('get_memory'), [`${PLUGIN}get_memory`, `${HAND}get_memory`])
  })
})

describe('allow-lists', () => {
  const lists = allowLists().filter((l) => l.tools.some((t) => devspecToolVerb(t)))

  it('the sweep found the lists it is meant to check', () => {
    // A discovery that finds nothing proves nothing.
    assert.ok(lists.some((l) => l.file === 'skills/devspec-remote-command/SKILL.md'))
    assert.ok(lists.some((l) => l.file === 'commands/devspec.remote.md'))
  })

  for (const { file, tools } of allowLists()) {
    it(`${file} names every DevSpec tool in both forms`, () => {
      const verbs = new Set(tools.map(devspecToolVerb).filter(Boolean))
      for (const verb of verbs) {
        for (const name of devspecToolNames(verb)) {
          assert.ok(tools.includes(name), `${file}: ${verb} is allowed as one name only — missing ${name}`)
        }
      }
    })
  }
})

describe('hook matchers', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'))
  const matchers = []
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      if (typeof value.matcher === 'string' && value.matcher.includes('devspec__')) matchers.push(value.matcher)
      Object.values(value).forEach(walk)
    }
  }
  walk(hooks)
  const verbs = new Set(allowLists().flatMap((l) => l.tools.map(devspecToolVerb).filter(Boolean)))

  it('found the DevSpec matchers', () => {
    assert.ok(matchers.length >= 2, `expected the claim/release and reply matchers, found ${matchers.length}`)
  })

  for (const matcher of matchers) {
    it(`"${matcher}" matches both forms of every verb it matches at all`, () => {
      const re = new RegExp(`^(?:${matcher})$`)
      let matchedAny = false
      for (const verb of verbs) {
        const [plugin, hand] = devspecToolNames(verb)
        if (re.test(plugin) || re.test(hand)) {
          matchedAny = true
          assert.ok(re.test(plugin), `${verb}: the plugin's own name is not matched`)
          assert.ok(re.test(hand), `${verb}: the hand-configured name is not matched`)
        }
      }
      assert.ok(matchedAny, 'matches no DevSpec tool at all')
    })
  }
})

describe('hook scripts', () => {
  it('compare verbs, never a raw DevSpec tool name', () => {
    const scripts = fs.readdirSync(here).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'devspec-tool-name.mjs')
    assert.ok(scripts.length > 5)
    for (const file of scripts) {
      const code = fs.readFileSync(path.join(here, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      assert.ok(!/['"`]mcp__(?:plugin_devspec_)?devspec__[a-z_]+['"`]/.test(code), `${file} compares a raw DevSpec tool name`)
    }
  })
})
