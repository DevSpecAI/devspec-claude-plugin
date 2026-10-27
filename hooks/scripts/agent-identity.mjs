/**
 * Single source of truth for THIS plugin's agent identity.
 *
 * The agent name is a fixed property of the plugin — not runtime state, not an
 * LLM-passed arg, not a copied fallback. Every script (poller, mirror-turn,
 * remote-control-state) imports AGENT_NAME and uses it as THE identity, so a
 * plugin can never mislabel itself (e.g. as "Grok Build") no matter what's in a
 * stale/foreign state file or whether `--agent` was passed. One line to set per
 * plugin; impossible to drift.
 */
export const AGENT_NAME = 'Claude Code'

/**
 * The id this plugin names itself by on every MCP request, as
 * `x-devspec-plugin: claude_code/<version>` (item 984ca8b4). DevSpec reads it to
 * tell a plugin client from one without a plugin, for agent health, and to say
 * "update your plugin" when a release genuinely breaks a tool's contract. It is
 * identification, never authority: the server runs every authority check itself.
 * The same value is written into `.claude-plugin/plugin.json`'s MCP headers for
 * the host's own client; connection-version.test.mjs keeps the two in step.
 */
export const PLUGIN_ID = 'claude_code'

/**
 * The environment variables THIS host uses for its own conversation id.
 *
 * Own host only. Another host's id is a real id for a real conversation — just
 * not this one — so adopting it is not a near-miss, it is answering as somebody
 * else. That happens whenever one agent launches another, which is now routine:
 * the child inherits the parent's whole environment.
 *
 * This list used to name every host's variable (`CODEX_THREAD_ID`,
 * `GROK_SESSION_ID`, `CURSOR_CONVERSATION_ID` …) so that one shared function
 * could serve every plugin. The generality was the bug (item 75f65461).
 *
 * Note the shape, because it is the fix: the function stays shared and
 * tool-agnostic, and the HOST supplies its own names. Hardcoding one host's
 * variable inside the shared resolver is the opposite mistake and broke every
 * non-Claude plugin once already (memory f90e2ff9) — that lesson stands.
 */
export const CONVERSATION_ID_ENV_VARS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']

/**
 * Explicit override, host-qualified on purpose.
 *
 * The bare `DEVSPEC_REMOTE_LOCAL_ID` is deliberately NOT read: it is the same
 * hazard wearing a neutral name. A parent agent that exports it hands it to
 * every child process it ever spawns, and each one then believes it is that
 * conversation.
 */
export const LOCAL_ID_OVERRIDE_ENV_VAR = 'DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE'
