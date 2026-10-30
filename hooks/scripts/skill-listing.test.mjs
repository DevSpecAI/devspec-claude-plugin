/**
 * The one size limit Claude Code puts on what this plugin's skills and commands say
 * about themselves.
 *
 * Claude Code lists every skill and command to the model by its `description` (plus
 * `when_to_use`), and truncates that combined text at 1,536 characters in the listing
 * (code.claude.com/docs/en/skills, frontmatter reference). Past it, the model decides
 * whether to load a skill from a description that has been cut off without anyone
 * being told. That is a real host ceiling, so it is checked; the byte ceilings on
 * skill and command bodies that used to sit in devspec-plan.test.mjs were not, and
 * went (item 9a4c0d6a).
 *
 * Discovers its subjects: every Markdown file with frontmatter under commands/ and
 * skills/, so a new skill cannot opt out by being forgotten.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Claude Code's own cap on description + when_to_use in the skill listing. */
const LISTING_DESCRIPTION_MAX_CHARS = 1_536

function listedFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.md') && fs.readFileSync(file, 'utf8').startsWith('---\n')) out.push(file)
    }
  }
  for (const dir of ['commands', 'skills']) walk(path.join(ROOT, dir))
  return out
}

/** A top-level frontmatter field's text: plain, quoted, or a `>` / `|` block. */
export function frontmatterField(source, field) {
  const end = source.indexOf('\n---', 4)
  const lines = source.slice(4, end === -1 ? undefined : end).split('\n')
  const at = lines.findIndex((line) => line.startsWith(`${field}:`))
  if (at === -1) return ''
  let value = lines[at].slice(field.length + 1).trim()
  if (/^[>|][-+]?$/.test(value) || value === '') {
    const block = []
    for (const line of lines.slice(at + 1)) {
      if (/^\S/.test(line)) break
      block.push(line.trim())
    }
    value = block.join(value.startsWith('|') ? '\n' : ' ').trim()
  }
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
  return quoted ? quoted[2] : value
}

describe('what the skill listing shows the model', () => {
  it('is never cut off by Claude Code', () => {
    const files = listedFiles()
    assert.ok(files.length >= 5, `found only ${files.length} skills and commands: the scan is broken, not clean`)
    const over = files
      .map((file) => {
        const text = fs.readFileSync(file, 'utf8')
        const listed = [frontmatterField(text, 'description'), frontmatterField(text, 'when_to_use')].filter(Boolean).join(' ')
        return { file: path.relative(ROOT, file), length: listed.length }
      })
      .filter(({ length }) => length > LISTING_DESCRIPTION_MAX_CHARS)
      .map(({ file, length }) => `${file}: ${length} characters`)
    assert.deepEqual(over, [], `longer than Claude Code's ${LISTING_DESCRIPTION_MAX_CHARS}-character listing cap:\n  ${over.join('\n  ')}`)
  })

  it('reads descriptions the way they are written', () => {
    const doc = (body) => `---\nname: x\n${body}\nallowed-tools: Read\n---\n\nBody`
    assert.equal(frontmatterField(doc('description: Plain words.'), 'description'), 'Plain words.')
    assert.equal(frontmatterField(doc('description: "Quoted: words."'), 'description'), 'Quoted: words.')
    assert.equal(frontmatterField(doc('description: >\n  Folded\n  lines.'), 'description'), 'Folded lines.')
    assert.equal(frontmatterField(doc('when_to_use: Later.'), 'description'), '')
  })
})

/**
 * Who the `/` menu is for. Claude Code puts every plugin skill in the menu unless its
 * frontmatter says `user-invocable: false`, and still lets the model load it either way.
 * This plugin's skills are instructions the agent reads for itself; the commands are
 * what a person runs. A skill left in the menu looked like a second remote command
 * (item 4ac8b0ab), so every skill must opt out and no command may.
 */
describe('what the / menu shows a person', () => {
  const inDir = (dir) => listedFiles().filter((file) => path.relative(ROOT, file).startsWith(`${dir}${path.sep}`))

  it('lists none of the skills', () => {
    const skills = inDir('skills')
    assert.ok(skills.length >= 1, 'found no skills: the scan is broken, not clean')
    const listed = skills
      .filter((file) => frontmatterField(fs.readFileSync(file, 'utf8'), 'user-invocable') !== 'false')
      .map((file) => path.relative(ROOT, file))
    assert.deepEqual(listed, [], `skills a person would see in the / menu (add \`user-invocable: false\`):\n  ${listed.join('\n  ')}`)
  })

  it('still lists every command', () => {
    const hidden = inDir('commands')
      .filter((file) => frontmatterField(fs.readFileSync(file, 'utf8'), 'user-invocable') === 'false')
      .map((file) => path.relative(ROOT, file))
    assert.deepEqual(hidden, [], `commands hidden from the / menu:\n  ${hidden.join('\n  ')}`)
  })
})
