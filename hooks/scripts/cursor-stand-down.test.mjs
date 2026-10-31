/**
 * Inside Cursor, this plugin's hooks do nothing (item 6d315656).
 *
 * Cursor's command-line agent loads the Claude Code plugins installed on the same
 * computer and runs their hooks too, mapping Claude Code's event names onto its own.
 * Measured on cursor-agent 2026.10.22: this plugin's SessionEnd hook ran inside a
 * Cursor session, identified the conversation from an inherited Claude Code session
 * id, and ended that Claude Code conversation's DevSpec connection. DevSpec's Cursor
 * plugin is the integration there; this one must stand aside.
 *
 * Cursor sets CURSOR_PLUGIN_ROOT for every plugin hook it runs (alongside
 * CLAUDE_PLUGIN_ROOT, which it also sets for compatibility), and passes
 * `cursor_version` in the hook's input. Claude Code sets neither. So every command in
 * hooks.json opens with a guard on CURSOR_PLUGIN_ROOT that prints an empty JSON
 * object, which Cursor accepts as "no opinion", and exits.
 *
 * This runs every hook command the way Cursor does, with a plugin root that does not
 * exist, so any command that got past its guard would try to run a missing script,
 * and checks each one printed only `{}`, wrote nothing to stderr and touched nothing
 * in its home folder.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks

const commands = Object.entries(hooks).flatMap(([event, groups]) =>
  groups.flatMap((group) => group.hooks.map((hook) => ({ event, matcher: group.matcher ?? '', command: hook.command }))),
)

// What Cursor hands a Claude Code plugin's hook: its own event name and version in
// the input, the event names it maps onto Claude Code's, and a tool call shaped like
// the ones Claude Code's matchers look for, so stdin-reading commands see realistic input.
function cursorInput(event) {
  return JSON.stringify({
    conversation_id: 'c0ffee00-0000-4000-8000-000000000000',
    session_id: 'c0ffee00-0000-4000-8000-000000000000',
    hook_event_name: event.charAt(0).toLowerCase() + event.slice(1),
    cursor_version: '2026.10.22-27dcf5f',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "x" && gh repo create && cat .devspec/project.json', run_in_background: true },
    tool_response: { backgroundTaskId: 'b1' },
  })
}

test('hooks.json has hook commands to check', () => {
  assert.ok(commands.length > 0)
})

for (const { event, matcher, command } of commands) {
  test(`inside Cursor, ${event}${matcher ? ` [${matcher}]` : ''} does nothing: ${command.slice(0, 90)}`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-stand-down-'))
    try {
      const missingPluginRoot = path.join(home, 'no-such-plugin')
      const result = spawnSync('bash', ['-c', command], {
        input: cursorInput(event),
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          CURSOR_PLUGIN_ROOT: missingPluginRoot,
          CLAUDE_PLUGIN_ROOT: missingPluginRoot,
          CURSOR_VERSION: '2026.10.22-27dcf5f',
          CURSOR_PROJECT_DIR: home,
          CLAUDE_PROJECT_DIR: home,
          // Present on purpose: the inherited Claude Code session id is what let the
          // SessionEnd hook end a live Claude Code conversation's connection.
          CLAUDE_CODE_SESSION_ID: 'c1aude00-0000-4000-8000-000000000000',
        },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, '{}\n')
      assert.equal(result.stderr, '')
      assert.deepEqual(fs.readdirSync(home), [], 'a hook wrote to the home folder')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
}

test('outside Cursor the guard lets the command run', () => {
  // The same guard Claude Code sees: no CURSOR_PLUGIN_ROOT, so it falls through.
  const guard = commands[0].command.slice(0, commands[0].command.indexOf('exit 0; }; ') + 'exit 0; }; '.length)
  for (const { command } of commands) assert.ok(command.startsWith(guard), `every hook opens with the same guard: ${command.slice(0, 90)}`)
  const result = spawnSync('bash', ['-c', `${guard}printf ran`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: '/opt/plugin' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'ran')
})
