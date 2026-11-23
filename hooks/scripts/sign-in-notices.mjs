/**
 * Everything the plugin tells a person about signing in to DevSpec (item 47f0dbdf), in one
 * place so every surface says the same thing: session start, the login, logout and status
 * commands, Remote, and a background feature whose request DevSpec refused.
 *
 * Written for someone who has never seen DevSpec's internals: what is wrong, and the one
 * step that fixes it. A saved login that stops working is never failed silently.
 */

import { environmentLabel, resourceKey } from './oauth.mjs'
import { TOKEN_ENV_VAR } from './auth-store.mjs'

export const LOGIN_COMMAND = '/devspec:devspec.login'
export const LOGOUT_COMMAND = '/devspec:devspec.logout'

const DEFAULT_APP_ORIGIN = 'https://app.devspec.ai'

/**
 * The DevSpec web-app origin of the deployment an MCP URL points at.
 *
 * Every deployment serves MCP from its `api.` host and the app from `app.` on the same
 * root domain (api.devspec.ai ↔ app.devspec.ai, api.devspecstaging.com ↔
 * app.devspecstaging.com). Any other host — localhost, or a URL already on the app host —
 * is its own app origin. Anything unreadable falls back to production, the same default
 * the MCP URL itself has. A plugin pointed at staging never links to production.
 */
export function devspecAppOrigin(mcpUrl) {
  let url
  try {
    url = new URL(String(mcpUrl ?? 'https://api.devspec.ai/api/mcp'))
  } catch {
    return DEFAULT_APP_ORIGIN
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_APP_ORIGIN
  if (url.hostname.startsWith('api.')) url.hostname = `app.${url.hostname.slice('api.'.length)}`
  return url.origin
}

/** DevSpec's Agent setup page, where a person connects and disconnects their tools. */
export function agentsSettingsUrl(mcpUrl) {
  return `${devspecAppOrigin(mcpUrl)}/settings/agents`
}

export function serverLabel(endpoint) {
  return resourceKey(endpoint) ? environmentLabel(endpoint) : String(endpoint ?? '')
}

export function notSignedInNotice(endpoint) {
  return `Claude Code is not signed in to DevSpec (${serverLabel(endpoint)}). ` +
    `Run ${LOGIN_COMMAND} to sign in through your browser.`
}

export function signInEndedNotice(endpoint) {
  return `Your DevSpec sign-in (${serverLabel(endpoint)}) has ended, for example because Claude Code was ` +
    `disconnected on ${agentsSettingsUrl(endpoint)}. Run ${LOGIN_COMMAND} to sign in again.`
}

function removeEnvVarSteps(platform) {
  return platform === 'win32'
    ? `remove ${TOKEN_ENV_VAR} from System Properties → Environment Variables and from any terminal profile that sets it`
    : `remove ${TOKEN_ENV_VAR} from your shell profile (for example ~/.zshrc or ~/.bashrc) and from this terminal (unset ${TOKEN_ENV_VAR})`
}

/**
 * DEVSPEC_MCP_TOKEN is set while a browser sign-in is saved for the same server.
 *
 * It is for machines with no browser, and it wins for everything the plugin itself sends.
 * Claude Code's own DevSpec connection cannot honor it over a saved sign-in: Claude Code
 * hides any variable whose name contains TOKEN from a plugin's header helper (measured on
 * 2.1.319; documented under "Which variables a helper can read"), so the helper cannot
 * know it is set. Saying exactly that is the plain failure the person needs.
 */
export function envTokenOverridesLoginNotice(platform = process.platform) {
  return `${TOKEN_ENV_VAR} is set, so DevSpec's background features (remote control and commit tracking) ` +
    'use that token instead of your browser sign-in, while Claude Code\'s own DevSpec connection keeps using ' +
    `the browser sign-in. To use one login everywhere, ${removeEnvVarSteps(platform)}, then restart Claude Code. ` +
    `Or run ${LOGOUT_COMMAND} to use only the token.`
}

/** Why the login command will not run while the environment token is set. */
export function loginRefusedForEnvTokenNotice(platform = process.platform) {
  return `${TOKEN_ENV_VAR} is set in this environment, and it always takes precedence over a browser sign-in, ` +
    `so signing in now would change nothing. To sign in through your browser, ${removeEnvVarSteps(platform)}, ` +
    `restart Claude Code, then run ${LOGIN_COMMAND} again.`
}

/**
 * The plain sentence for a credential DevSpec refused, or null when the failure is not a
 * refusal (offline, a redeploy, a tool error). `err` is what mcp-call.mjs throws: HTTP
 * status in `status`, DevSpec's machine code in `serverCode`.
 *
 *   signed_out         the person disconnected Claude Code on the Agent setup page. DevSpec's
 *                      own sentence says where to reconnect; signing in again follows.
 *   invalid_api_token  unknown, expired or revoked.
 */
export function refusedCredentialMessage(err, { endpoint = null, source = 'login' } = {}) {
  // Only DevSpec's explicit word counts: a gateway's bare 401 is no proof the sign-in ended.
  const code = typeof err?.serverCode === 'string' ? err.serverCode : null
  if (code === 'signed_out') {
    const said = serverSentence(err) ||
      'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.'
    return `${said} Then run ${LOGIN_COMMAND}.`
  }
  if (code === 'invalid_api_token') {
    if (source === 'env') {
      return `DevSpec refused the token in ${TOKEN_ENV_VAR}. Replace it with a working token, or remove it and run ${LOGIN_COMMAND}.`
    }
    return `DevSpec refused your saved sign-in${endpoint ? ` (${serverLabel(endpoint)})` : ''}. Run ${LOGIN_COMMAND} to sign in again.`
  }
  return null
}

/** DevSpec's own `error` sentence from a refused request's body, when it has one. */
export function serverSentence(err) {
  const message = typeof err?.message === 'string' ? err.message : ''
  const start = message.indexOf('{')
  if (start < 0) return null
  try {
    const body = JSON.parse(message.slice(start))
    return typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : null
  } catch {
    return null
  }
}

/**
 * What to say when no usable credential exists for `endpoint`, from what the store holds:
 * `{ kind: 'none' | 'ended' }` (auth-store.mjs `loginState`).
 */
export function missingCredentialNotice(state, endpoint) {
  return state?.kind === 'ended' ? signInEndedNotice(endpoint) : notSignedInNotice(endpoint)
}
