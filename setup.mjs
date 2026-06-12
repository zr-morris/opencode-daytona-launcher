#!/usr/bin/env node
/*
 * OpenCode + Daytona launcher — one-command self-host deployer.
 *
 * Programmatically creates a Render web service in YOUR OWN Render account and
 * deploys this launcher to it. No browser needed for the common case.
 *
 *   npm run setup
 *
 * Uses only Node built-ins (Node 18+ for global fetch). Reads answers from
 * prompts, falling back to environment variables so it can run non-interactively
 * (e.g. RENDER_API_KEY=... DAYTONA_API_KEY=... npm run setup).
 *
 * IMPORTANT: Render's API can only auto-create a service from a PUBLIC GitHub
 * repo URL without a browser GitHub connection. Such services do NOT get
 * auto-deploy — push changes, then run `npm run deploy` to redeploy.
 */
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'

const RENDER_API = 'https://api.render.com/v1'

function log(...a) { console.log(...a) }
function last4(v) { return v ? '...' + String(v).slice(-4) : '(none)' }

async function main() {
  log('\n=== OpenCode on Daytona — self-host setup ===')
  log('This creates a Render web service in YOUR Render account and deploys this launcher.\n')

  const NONINTERACTIVE = process.env.NONINTERACTIVE === '1' || !input.isTTY
  const rl = NONINTERACTIVE ? null : readline.createInterface({ input, output })
  const ask = async (q, def) => {
    if (NONINTERACTIVE) { if (def) console.log(`${q}: ${def}`); return def || '' }
    const suffix = def ? ` [${def}]` : ''
    const a = (await rl.question(`${q}${suffix}: `)).trim()
    return a || def || ''
  }

  try {
    // --- 1. Repo URL (auto-detect from git, confirm/override) ---
    let detected = ''
    try {
      const raw = execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      detected = normalizeRepo(raw)
    } catch { /* no git remote */ }
    log('NOTE: the repo MUST be PUBLIC for automatic deploy. Services created from a')
    log('public repo URL do not auto-deploy; push changes then run `npm run deploy`.\n')
    const repo = await ask('Public GitHub repo URL to deploy', detected || process.env.DEPLOY_REPO)
    if (!repo) { log('A repo URL is required. Aborting.'); rl && rl.close(); process.exit(1) }
    await checkPublicRepo(repo, ask)

    // --- 2. Credentials ---
    const renderKey = (await askSecret(rl, 'Render API key (required)', process.env.RENDER_API_KEY))
    if (!renderKey) { log('Render API key is required. Aborting.'); rl && rl.close(); process.exit(1) }
    const daytonaKey = (await askSecret(rl, 'Daytona API key (required, baked into the deploy)', process.env.DAYTONA_API_KEY))
    if (!daytonaKey) { log('Daytona API key is required. Aborting.'); rl && rl.close(); process.exit(1) }
    const daytonaTarget = await ask('Daytona region (us/eu)', process.env.DAYTONA_TARGET || 'us')

    log('\nOptional: enable GitHub login gate (leave blank to skip).')
    const ghClientId = await ask('GitHub OAuth Client ID', process.env.GITHUB_CLIENT_ID || '')
    let ghClientSecret = ''
    let sessionSecret = ''
    let allowedUsers = ''
    let allowedOrg = ''
    if (ghClientId) {
      ghClientSecret = await askSecret(rl, 'GitHub OAuth Client Secret', process.env.GITHUB_CLIENT_SECRET)
      allowedUsers = await ask('Allowed GitHub usernames (comma-separated)', process.env.ALLOWED_GITHUB_USERS || '')
      allowedOrg = await ask('Allowed GitHub org (optional)', process.env.ALLOWED_GITHUB_ORG || '')
      sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
      log('  (generated a random SESSION_SECRET)')
    }

    const defaultName = repoName(repo) || 'opencode-launcher'
    const name = await ask('Render service name', process.env.SERVICE_NAME || defaultName)

    // --- 3. Render owner ---
    log('\nLooking up your Render account...')
    const owners = await renderGET(renderKey, '/owners?limit=20')
    const ownerList = (Array.isArray(owners) ? owners : []).map((x) => x.owner || x)
    if (!ownerList.length) { log('No Render owners found for this API key. Aborting.'); rl && rl.close(); process.exit(1) }
    let owner = ownerList[0]
    if (ownerList.length > 1) {
      log('Multiple Render owners:')
      ownerList.forEach((o, i) => log(`  [${i}] ${o.name} (${o.type})`))
      const idx = parseInt(await ask('Choose owner index', '0'), 10) || 0
      owner = ownerList[idx] || ownerList[0]
    }
    log(`Using owner: ${owner.name} (${owner.type})`)

    // --- 4. Create the service ---
    log(`\nCreating Render web service "${name}" from ${repo} ...`)
    const createBody = {
      type: 'web_service',
      name,
      ownerId: owner.id,
      repo,
      autoDeploy: 'no', // public-repo services can't auto-deploy
      serviceDetails: {
        env: 'node',
        plan: 'free',
        envSpecificDetails: {
          buildCommand: 'npm install && npm run build',
          startCommand: 'npm start',
        },
      },
    }
    const created = await renderPOST(renderKey, '/services', createBody)
    const svc = created.service || created
    const serviceId = svc.id || (svc.service && svc.service.id)
    if (!serviceId) { log('Could not determine new service id. Response:'); log(JSON.stringify(created, null, 2)); rl && rl.close(); process.exit(1) }
    log(`Service created: ${serviceId}`)
    fs.writeFileSync('.render-service', serviceId + '\n')

    // --- 5. Env vars ---
    const envVars = [{ key: 'DAYTONA_API_KEY', value: daytonaKey }]
    if (daytonaTarget && daytonaTarget !== 'us') envVars.push({ key: 'DAYTONA_TARGET', value: daytonaTarget })
    if (ghClientId) {
      envVars.push({ key: 'GITHUB_CLIENT_ID', value: ghClientId })
      envVars.push({ key: 'GITHUB_CLIENT_SECRET', value: ghClientSecret })
      envVars.push({ key: 'SESSION_SECRET', value: sessionSecret })
      if (allowedUsers) envVars.push({ key: 'ALLOWED_GITHUB_USERS', value: allowedUsers })
      if (allowedOrg) envVars.push({ key: 'ALLOWED_GITHUB_ORG', value: allowedOrg })
    }
    log(`Setting ${envVars.length} environment variable(s): ${envVars.map((e) => e.key).join(', ')}`)
    await renderPUT(renderKey, `/services/${serviceId}/env-vars`, envVars)

    // --- 6. Deploy + poll ---
    log('Triggering deploy...')
    const dep = await renderPOST(renderKey, `/services/${serviceId}/deploys`, {})
    const deployId = dep.id || (dep.deploy && dep.deploy.id)
    log(`Deploy ${deployId || '(unknown id)'} started. Waiting for it to go live (up to ~15 min)...`)
    const live = await pollDeploy(renderKey, serviceId, deployId)

    // --- 7. Resolve URL + next steps ---
    const svcAfter = await renderGET(renderKey, `/services/${serviceId}`)
    const url = findUrl(svcAfter) || findUrl(svc) || ''
    if (url) {
      // set APP_BASE_URL so OAuth callbacks resolve correctly
      try {
        const merged = envVars.concat([{ key: 'APP_BASE_URL', value: url }])
        await renderPUT(renderKey, `/services/${serviceId}/env-vars`, merged)
      } catch { /* non-fatal */ }
    }

    log('\n========================================')
    log(live ? 'DEPLOY LIVE' : 'Deploy did not confirm live in time (check the Render dashboard).')
    if (url) log(`URL: ${url}`)
    log('========================================')
    log('Next steps:')
    log('  - Open the URL above. Daytona is already configured (baked in), so you go straight to the dashboard.')
    log('  - Connect Linear/Render (optional) in Settings; keys stay in your browser.')
    if (ghClientId && url) {
      log('  - GitHub login is enabled. In your GitHub OAuth app, set the Authorization callback URL to:')
      log(`      ${url}/auth/github/callback`)
    } else if (!ghClientId) {
      log('  - To require GitHub login later, create a GitHub OAuth app and re-run setup (or set the GitHub env vars in Render).')
    }
    log('  - Public-repo services do NOT auto-deploy. After pushing changes, run: npm run deploy')
    log('')
    rl && rl.close()
  } catch (err) {
    log('\nSetup failed: ' + (err && err.message ? err.message : String(err)))
    rl && rl.close()
    process.exit(1)
  }
}

// ---- helpers ----
function normalizeRepo(raw) {
  let u = raw.trim()
  const m = u.match(/^git@github\.com:(.+?)(\.git)?$/)
  if (m) return 'https://github.com/' + m[1]
  u = u.replace(/\.git$/, '')
  return u
}
function repoName(repo) {
  const m = repo.match(/github\.com\/[^/]+\/([^/]+)/)
  return m ? m[1] : ''
}
async function askSecret(rl, q, envVal) {
  if (envVal) { console.log(`${q}: using value from environment (${last4(envVal)})`); return envVal }
  if (!rl) return '' // non-interactive and no env value -> caller handles the 'required' error
  return (await rl.question(`${q}: `)).trim()
}
async function checkPublicRepo(repo, ask) {
  const m = repo.match(/github\.com\/([^/]+)\/([^/]+)/)
  if (!m) return
  try {
    const r = await fetchT(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { 'User-Agent': 'opencode-setup', Accept: 'application/vnd.github+json' } })
    if (r.status === 404) {
      const go = await ask('That repo looks private or missing (GitHub 404). Continue anyway? (y/N)', 'N')
      if (String(go).toLowerCase() !== 'y') { console.log('Aborting. Make the repo public, then re-run.'); process.exit(1) }
    }
  } catch { /* network hiccup; continue */ }
}
function findUrl(obj) {
  if (!obj) return ''
  const sd = obj.serviceDetails || (obj.service && obj.service.serviceDetails) || {}
  return sd.url || obj.url || ''
}
async function fetchT(url, init, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms)
  try { return await fetch(url, { ...(init || {}), signal: c.signal }) } finally { clearTimeout(t) }
}
async function renderGET(key, path) {
  const r = await fetchT(`${RENDER_API}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } })
  const body = await r.text()
  if (!r.ok) throw new Error(`Render GET ${path} -> HTTP ${r.status}: ${body.slice(0, 300)}`)
  return body ? JSON.parse(body) : null
}
async function renderPOST(key, path, payload) {
  const r = await fetchT(`${RENDER_API}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) })
  const body = await r.text()
  if (!r.ok) throw new Error(`Render POST ${path} -> HTTP ${r.status}: ${body.slice(0, 400)}`)
  return body ? JSON.parse(body) : {}
}
async function renderPUT(key, path, payload) {
  const r = await fetchT(`${RENDER_API}${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) })
  const body = await r.text()
  if (!r.ok) throw new Error(`Render PUT ${path} -> HTTP ${r.status}: ${body.slice(0, 400)}`)
  return body ? JSON.parse(body) : {}
}
async function pollDeploy(key, serviceId, deployId) {
  const TERMINAL_BAD = new Set(['build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed'])
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 15000))
    try {
      let status
      if (deployId) {
        const d = await renderGET(key, `/services/${serviceId}/deploys/${deployId}`)
        status = (d.deploy || d).status
      } else {
        const arr = await renderGET(key, `/services/${serviceId}/deploys?limit=1`)
        status = (arr[0] && (arr[0].deploy || arr[0]).status) || 'unknown'
      }
      console.log(`  [${i + 1}] status=${status}`)
      if (status === 'live') return true
      if (TERMINAL_BAD.has(status)) return false
    } catch (e) { console.log('  (poll error, retrying): ' + e.message) }
  }
  return false
}

main()
