/**
 * Every hook command line runs the plugin's own scripts by fixed path with fixed
 * arguments (item f1804a6e).
 *
 * On 5 November 2026 the Anthropic plugin directory refused 0.52.5 with one blocking
 * finding, "Unpinned npx launcher", on exactly the four commit-drain hooks
 * (PostToolUse, Stop, StopFailure, SubagentStop). The plugin uses no npx. Those four
 * lines were the only ones that pulled the session id out of the hook input with grep
 * and sed and then used the value they derived; the directory's checker reads any word
 * a shell could expand into a package launcher as one. Its advice: run the one program
 * the hook needs, by name, with fixed arguments.
 *
 * So no hook line may use a pattern-matching tool, and the only command substitution
 * allowed is the one that reads the hook input (`input=$(cat)`), which every
 * filtering hook already uses and the directory accepted. The check for a waiting
 * commit lives in git-observer.mjs instead, and the drain tests below run the real
 * hook command to prove it still reports a waiting commit and stays cheap when
 * nothing is waiting.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks

const commands = Object.entries(hooks).flatMap(([event, groups]) =>
  groups.flatMap((group) => group.hooks.map((hook) => ({ event, matcher: group.matcher ?? '', command: hook.command ?? '' }))),
)
const label = ({ event, matcher }) => `${event}${matcher ? ` [${matcher}]` : ''}`

describe('every hook command line', () => {
  it('has commands to check', () => assert.ok(commands.length > 0))

  for (const entry of commands) {
    it(`${label(entry)} uses no pattern-matching tool`, () => {
      assert.doesNotMatch(entry.command, /(^|[\s;|&(])(grep|egrep|fgrep|sed|awk|gawk|perl|python3?|jq)(\s|$)/)
    })

    it(`${label(entry)} substitutes nothing but the hook input`, () => {
      const substitutions = entry.command.match(/\$\([^)]*\)|`[^`]*`/g) ?? []
      assert.deepEqual(substitutions.filter((s) => s !== '$(cat)'), [])
    })

    it(`${label(entry)} runs only the plugin's own scripts, by fixed path with fixed arguments`, () => {
      // node in command position: at the start, or after ; | & { then do (not `command -v node`).
      // Its arguments are literal words or double-quoted literals, never an expansion.
      const runs = [...entry.command.matchAll(/(?:^|[;|&{]\s*|\b(?:then|do)\s+)(node\s+[^;|&]*)/g)].map((m) => m[1])
      for (const run of runs) {
        assert.match(run.trim(), /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/[\w-]+\.mjs"( (?:[A-Za-z0-9_-]+|"[^"$`\\]*"))*$/, run)
      }
      assert.doesNotMatch(entry.command, /\b(npx|bunx|uvx|pnpx|npm exec|pnpm dlx|yarn dlx)\b/)
    })
  }
})

describe('the commit-drain hooks, run the way Claude Code runs them', () => {
  const SESSION = 'a1b2c3d4-0000-4000-8000-00000000d1a1'
  const drains = commands.filter((c) => c.command.includes('git-observer.mjs" drain'))

  // A copy of the plugin's scripts whose reporting module leaves a mark when it loads,
  // so each run shows whether the drain got as far as the reporting code.
  const pluginCopy = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-shape-plugin-'))
    fs.cpSync(path.join(ROOT, 'hooks', 'scripts'), path.join(root, 'hooks', 'scripts'), {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules`),
    })
    fs.writeFileSync(
      path.join(root, 'hooks', 'scripts', 'commit-observation.mjs'),
      "import fs from 'node:fs'\nfs.writeFileSync(process.env.REPORTING_LOADED, 'loaded')\nexport function boundConnection() { return null }\n",
    )
    return root
  }

  // A drain with nothing to do exits before reading its input, so under load the
  // write can land after sh has gone and fail with EPIPE. That is the quiet exit
  // being tested, not a failure: a clean exit with EPIPE returns what it printed.
  const run = (command, { home, pluginRoot, marker }) => {
    try {
      return execFileSync('sh', ['-c', command], {
        input: JSON.stringify({ session_id: SESSION, hook_event_name: 'Stop', tool_name: 'Bash' }),
        env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot, REPORTING_LOADED: marker },
        encoding: 'utf8',
      })
    } catch (error) {
      if (error?.code === 'EPIPE' && error.status === 0 && error.signal === null) return error.stdout ?? ''
      throw error
    }
  }

  it('covers the four drain events', () => {
    assert.deepEqual(drains.map((d) => d.event).sort(), ['PostToolUse', 'Stop', 'StopFailure', 'SubagentStop'])
  })

  const pluginRoot = pluginCopy()
  for (const entry of drains) {
    it(`${label(entry)} with no observer state exits quietly without starting the reporting code`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-shape-home-'))
      const marker = path.join(home, 'loaded')
      assert.equal(run(entry.command, { home, pluginRoot, marker }), '')
      assert.equal(fs.existsSync(marker), false)
    })

    it(`${label(entry)} with nothing pending for this conversation stops before the reporting code`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-shape-home-'))
      fs.mkdirSync(path.join(home, '.devspec', 'git-observer', SESSION), { recursive: true })
      fs.mkdirSync(path.join(home, '.devspec', 'git-observer', 'another-session'), { recursive: true })
      fs.writeFileSync(path.join(home, '.devspec', 'git-observer', 'another-session', 'pending'), '')
      const marker = path.join(home, 'loaded')
      assert.equal(run(entry.command, { home, pluginRoot, marker }), '')
      assert.equal(fs.existsSync(marker), false, 'another conversation\'s commit does not wake this one')
    })

    it(`${label(entry)} with a commit pending reaches the reporting code`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-shape-home-'))
      fs.mkdirSync(path.join(home, '.devspec', 'git-observer', SESSION), { recursive: true })
      fs.writeFileSync(path.join(home, '.devspec', 'git-observer', SESSION, 'pending'), '')
      const marker = path.join(home, 'loaded')
      assert.equal(run(entry.command, { home, pluginRoot, marker }), '')
      assert.equal(fs.readFileSync(marker, 'utf8'), 'loaded')
    })
  }
})
