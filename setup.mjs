#!/usr/bin/env node
/*
 * OpenCode — Azure Foundry edition: guided install.
 *
 *   npm run setup
 *
 * Captures (and LIVE-TESTS) the firm's configuration, then writes:
 *   - .env          (secrets + settings; gitignored)
 *   - opencode.json (Azure Foundry provider + deployments + default model)
 *
 * After this, `npm run build && npm start` runs an app that "just works":
 * OpenCode in Daytona sandboxes defaulting to your Azure Foundry deployment,
 * gated by corporate Entra SSO.
 *
 * Designed to be run by a DevOps person inside (or with line-of-sight to) the
 * Azure VNet, so the live tests against the private Foundry endpoint succeed.
 *
 * Node built-ins only + @azure/identity (already a dependency) for the Entra
 * managed-identity live test.
 */
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import crypto from 'node:crypto'
import fs from 'node:fs'

const NONINTERACTIVE = process.env.NONINTERACTIVE === '1' || !input.isTTY
const rl = NONINTERACTIVE ? null : readline.createInterface({ input, output })
const log = (...a) => console.log(...a)
const last4 = (v) => (v ? '...' + String(v).slice(-4) : '(none)')

async function ask(q, def) {
  if (NONINTERACTIVE) { if (def) log(`${q}: ${def}`); return def || '' }
  const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim()
  return a || def || ''
}
async function askReq(q, envVal) {
  if (envVal) { log(`${q}: (from env ${last4(envVal)})`); return envVal }
  if (NONINTERACTIVE) return ''
  let v = ''
  while (!v) { v = (await rl.question(`${q} (required): `)).trim(); if (!v) log('  ...required.') }
  return v
}
async function askYN(q, defYes) {
  const d = defYes ? 'Y/n' : 'y/N'
  const a = (await ask(`${q} (${d})`, defYes ? 'Y' : 'N')).toLowerCase()
  return a.startsWith('y')
}

async function fetchT(url, init, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms)
  try { return await fetch(url, { ...(init || {}), signal: c.signal }) } finally { clearTimeout(t) }
}

async function main() {
  log('\n=== OpenCode (Azure Foundry edition) — install ===')
  log('This configures Daytona (self-hosted), Azure Foundry (Entra), and corporate')
  log('SSO, live-tests them, and writes .env + opencode.json so the app just works.\n')

  const cfg = {}

  // ---------- 1. Self-hosted Daytona ----------
  log('--- Self-hosted Daytona ---')
  cfg.DAYTONA_API_URL = await askReq('Daytona API base URL (your self-hosted control plane, e.g. https://daytona.firm.internal/api)', process.env.DAYTONA_API_URL)
  cfg.DAYTONA_API_KEY = await askReq('Daytona API key', process.env.DAYTONA_API_KEY)
  cfg.DAYTONA_TARGET = await ask('Daytona target/region (optional)', process.env.DAYTONA_TARGET || '')
  await testDaytona(cfg)

  // ---------- 2. Azure Foundry ----------
  log('\n--- Azure AI Foundry ---')
  cfg.AZURE_FOUNDRY_BASE_URL = await askReq('Foundry base endpoint URL (e.g. https://my-res.services.ai.azure.com)', process.env.AZURE_FOUNDRY_BASE_URL)
  cfg.AZURE_FOUNDRY_BASE_URL = cfg.AZURE_FOUNDRY_BASE_URL.replace(/\/$/, '')
  cfg.AZURE_API_VERSION = await ask('Foundry API version (blank for v1 GA, else e.g. 2025-04-01-preview)', process.env.AZURE_API_VERSION || '')
  const deploymentsRaw = await askReq('Deployment name(s), comma-separated (must match Azure exactly, e.g. gpt-4o,gpt-5.5)', process.env.AZURE_DEPLOYMENTS)
  const deployments = deploymentsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  cfg.AZURE_DEFAULT_DEPLOYMENT = deployments.length === 1
    ? deployments[0]
    : await askReq('Default deployment (one of: ' + deployments.join(', ') + ')', process.env.AZURE_DEFAULT_DEPLOYMENT)

  // Auth mode: Entra (managed identity) primary, API key fallback.
  const useEntra = await askYN('Authenticate to Foundry with Entra managed identity (recommended; no API key)?', true)
  cfg.AZURE_AUTH_MODE = useEntra ? 'entra' : 'apikey'
  if (!useEntra) {
    cfg.AZURE_API_KEY = await askReq('Foundry API key', process.env.AZURE_API_KEY)
  }
  cfg.AZURE_TOKEN_SCOPE = await ask('Entra token scope for Foundry', process.env.AZURE_TOKEN_SCOPE || 'https://cognitiveservices.azure.com/.default')
  await testFoundry(cfg, deployments)

  // ---------- 3. Corporate Entra SSO (app login) ----------
  log('\n--- Corporate SSO (Entra) ---')
  const wantSSO = await askYN('Require corporate Microsoft (Entra) sign-in to use the app?', true)
  if (wantSSO) {
    cfg.ENTRA_TENANT_ID = await askReq('Entra tenant ID (directory ID)', process.env.ENTRA_TENANT_ID)
    cfg.ENTRA_CLIENT_ID = await askReq('Entra app (client) ID', process.env.ENTRA_CLIENT_ID)
    cfg.ENTRA_CLIENT_SECRET = await askReq('Entra client secret', process.env.ENTRA_CLIENT_SECRET)
    cfg.APP_BASE_URL = await ask('App base URL (where users reach this, e.g. https://opencode.firm.internal)', process.env.APP_BASE_URL || '')
    cfg.SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
    log('  (generated a SESSION_SECRET)')
    if (cfg.APP_BASE_URL) {
      log('  IMPORTANT: in the Entra app registration, add this redirect URI:')
      log('    ' + cfg.APP_BASE_URL.replace(/\/$/, '') + '/auth/callback')
    }
  } else {
    log('  SSO disabled — anyone who can reach the app URL can use it (rely on network access controls).')
  }

  // ---------- 4. Write files ----------
  writeEnv(cfg)
  writeOpencodeJson(cfg, deployments)

  log('\n========================================')
  log('Setup complete. Wrote .env and opencode.json.')
  log('Next:')
  log('  npm run build')
  log('  npm start         # local check, or build the Docker image for your VNet')
  log('Deploy the container into your Azure VNet (see README / Dockerfile).')
  log('========================================\n')
  rl && rl.close()
}

// ---------- live tests ----------
async function testDaytona(cfg) {
  log('Testing Daytona connectivity...')
  try {
    const { Daytona } = await import('@daytona/sdk')
    const opts = { apiKey: cfg.DAYTONA_API_KEY }
    if (cfg.DAYTONA_API_URL) opts.apiUrl = cfg.DAYTONA_API_URL
    if (cfg.DAYTONA_TARGET) opts.target = cfg.DAYTONA_TARGET
    const d = new Daytona(opts)
    for await (const _sb of d.list()) break // any auth-ed call
    log('  ✓ Daytona reachable and authenticated.')
  } catch (e) {
    log('  ✗ Daytona test failed: ' + (e?.message || e))
    if (!(await askYN('  Continue anyway?', false))) { rl && rl.close(); process.exit(1) }
  }
}

async function testFoundry(cfg, deployments) {
  log('Testing Azure Foundry endpoint...')
  // 1. get auth (token via managed identity, or key)
  let authHeader = {}
  if (cfg.AZURE_AUTH_MODE === 'entra') {
    try {
      const { DefaultAzureCredential } = await import('@azure/identity')
      const cred = new DefaultAzureCredential()
      const tok = await cred.getToken(cfg.AZURE_TOKEN_SCOPE)
      if (!tok?.token) throw new Error('no token returned')
      authHeader = { Authorization: 'Bearer ' + tok.token }
      log('  ✓ Acquired Entra token (managed identity / dev credential).')
    } catch (e) {
      log('  ✗ Could not get Entra token: ' + (e?.message || e))
      log('    (This is expected if you are NOT running inside the VNet with a managed identity.')
      log('     The deployed app will acquire the token at runtime. Skipping live Foundry call.)')
      return
    }
  } else {
    authHeader = { 'api-key': cfg.AZURE_API_KEY }
  }
  // 2. probe the endpoint shape: try v1 chat completions, then deployment-based.
  const dep = deployments[0]
  const v = cfg.AZURE_API_VERSION
  const candidates = [
    { label: 'v1 chat completions', url: cfg.AZURE_FOUNDRY_BASE_URL + '/openai/v1/chat/completions' + (v ? `?api-version=${v}` : ''), shape: 'v1' },
    { label: 'deployment chat completions', url: cfg.AZURE_FOUNDRY_BASE_URL + `/openai/deployments/${dep}/chat/completions` + (v ? `?api-version=${v}` : '?api-version=2025-04-01-preview'), shape: 'deployment' },
  ]
  for (const c of candidates) {
    try {
      const body = JSON.stringify({ model: dep, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
      const r = await fetchT(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader }, body }, 20000)
      log(`  [${c.label}] HTTP ${r.status}`)
      if (r.ok) { log('  ✓ Foundry responded successfully via ' + c.label + '.'); cfg.AZURE_URL_SHAPE = c.shape; return }
      if (r.status === 401 || r.status === 403) { log('  ✗ Auth rejected (check token scope / RBAC role on the resource).'); }
    } catch (e) { log(`  [${c.label}] error: ${e?.message || e}`) }
  }
  log('  ! Could not confirm a working Foundry call. Verify endpoint/deployment/version with your team.')
  if (!(await askYN('  Continue anyway?', false))) { rl && rl.close(); process.exit(1) }
}

// ---------- file writers ----------
function writeEnv(cfg) {
  const lines = ['# Generated by `npm run setup`. Do NOT commit. (gitignored)']
  const put = (k) => { if (cfg[k] !== undefined && cfg[k] !== '') lines.push(`${k}=${cfg[k]}`) }
  ;['DAYTONA_API_URL','DAYTONA_API_KEY','DAYTONA_TARGET',
    'AZURE_FOUNDRY_BASE_URL','AZURE_API_VERSION','AZURE_DEFAULT_DEPLOYMENT','AZURE_AUTH_MODE','AZURE_API_KEY','AZURE_TOKEN_SCOPE',
    'ENTRA_TENANT_ID','ENTRA_CLIENT_ID','ENTRA_CLIENT_SECRET','SESSION_SECRET','APP_BASE_URL'].forEach(put)
  fs.writeFileSync('.env', lines.join('\n') + '\n')
  log('  wrote .env (' + (lines.length - 1) + ' settings)')
}

function writeOpencodeJson(cfg, deployments) {
  // Azure Foundry provider config. resourceName is intentionally NOT set for
  // Foundry (cognitiveservices/services.ai domains) — baseURL drives the URL.
  const models = {}
  for (const d of deployments) models[d] = { name: d }
  const provider = {
    azure: {
      options: {
        baseURL: cfg.AZURE_FOUNDRY_BASE_URL + '/openai/v1',
      },
      models,
    },
  }
  if (cfg.AZURE_API_VERSION) provider.azure.options.apiVersion = cfg.AZURE_API_VERSION
  // Auth: apikey via env; entra token via env (read by the launcher/runtime).
  if (cfg.AZURE_AUTH_MODE === 'apikey') provider.azure.options.apiKey = '{env:AZURE_API_KEY}'
  else provider.azure.options.apiKey = '{env:AZURE_FOUNDRY_TOKEN}'
  const out = {
    $schema: 'https://opencode.ai/config.json',
    provider,
    model: 'azure/' + cfg.AZURE_DEFAULT_DEPLOYMENT,
  }
  fs.writeFileSync('opencode.json', JSON.stringify(out, null, 2) + '\n')
  log('  wrote opencode.json (default model azure/' + cfg.AZURE_DEFAULT_DEPLOYMENT + ')')
}

main().catch((e) => { log('\nSetup failed: ' + (e?.message || e)); rl && rl.close(); process.exit(1) })
