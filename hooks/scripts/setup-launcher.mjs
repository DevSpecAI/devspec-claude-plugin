#!/usr/bin/env node
/** Claude owns credential resolution and the authenticated identity request. */
import { createHash } from 'node:crypto'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'
import { setupFromPlugin } from '../../launcher/plugin-setup.mjs'
if (process.env.DEVSPEC_LAUNCHER_DISABLED !== '1') {
  try {
    const auth = resolveDevspecMcpAuth(process.cwd(), { hostToken: hostTokenFromEnv(process.env) })
    const result = await setupFromPlugin({ account: auth.ok && auth.token && auth.mcp_url ? {
      fingerprint: createHash('sha256').update(auth.token).digest('hex'),
      endpoint: auth.mcp_url,
      verifyAccount: async publicKey => {
        const response = await fetch(new URL('/api/launcher/pair', auth.mcp_url), { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey }), signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error('Local launcher account pairing failed')
        return response.json()
      },
    } : undefined })
    if (!result.ok && !['disabled', 'busy'].includes(result.outcome)) console.error('DevSpec local launching is not ready. Connect this plugin to your DevSpec account or use Copy command.')
  } catch { console.error('DevSpec local launching could not be checked. Copy commands remain available.') }
}
process.exitCode = 0
