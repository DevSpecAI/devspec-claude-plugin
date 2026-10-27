/**
 * Which DevSpec tool a Claude Code tool name refers to (item ddc40cc8).
 *
 * The same DevSpec tool reaches Claude Code under two names:
 *
 *   mcp__plugin_devspec_devspec__<verb>   the server this plugin ships
 *                                         (.claude-plugin/plugin.json mcpServers.devspec)
 *   mcp__devspec__<verb>                  a server someone configured by hand and
 *                                         called `devspec` (still supported by
 *                                         resolve-mcp-auth.mjs)
 *
 * Every hook here used to compare against the second form only, so on a plain
 * plugin install — the way customers connect — the claim, release and reply hooks
 * never ran and nothing said so. Compare verbs, never raw names.
 */

const DEVSPEC_TOOL_RE = /^mcp__(?:plugin_devspec_)?devspec__([a-z0-9_]+)$/

/** The DevSpec verb a tool name calls, or null when it is not a DevSpec tool. */
export function devspecToolVerb(toolName) {
  if (typeof toolName !== 'string') return null
  const match = DEVSPEC_TOOL_RE.exec(toolName)
  return match ? match[1] : null
}

/** Both names a verb can arrive under, for allow-lists and hook matchers. */
export function devspecToolNames(verb) {
  return [`mcp__plugin_devspec_devspec__${verb}`, `mcp__devspec__${verb}`]
}
