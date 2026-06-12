#!/usr/bin/env node
/*
 * Redeploy the launcher to Render (for public-repo services, which don't
 * auto-deploy). After you push changes to your fork, run:  npm run deploy
 *
 * Reads RENDER_API_KEY from env or prompts. Reads the service id from the
 * .render-service file written by setup.mjs, or prompts for it.
 */
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import fs from 'node:fs'

const RENDER_API = 'https://api.render.com/v1'
const log = (...a) => console.log(...a)

async function fetchT(url, init, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms)
  try { return await fetch(url, { ...(init || {}), signal: c.signal }) } finally { clearTimeout(t) }
}
async function rGET(key, p) {
  const r = await fetchT(`${RENDER_API}${p}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } })
  const b = await r.text(); if (!r.ok) throw new Error(`GET ${p} HTTP ${r.status}: ${b.slice(0,200)}`); return b ? JSON.parse(b) : null
}
async function rPOST(key, p, payload) {
  const r = await fetchT(`${RENDER_API}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) })
  const b = await r.text(); if (!r.ok) throw new Error(`POST ${p} HTTP ${r.status}: ${b.slice(0,300)}`); return b ? JSON.parse(b) : {}
}

async function main() {
  const rl = readline.createInterface({ input, output })
  try {
    let key = process.env.RENDER_API_KEY
    if (!key) key = (await rl.question('Render API key: ')).trim()
    if (!key) { log('Render API key required.'); rl.close(); process.exit(1) }

    let serviceId = process.env.RENDER_SERVICE_ID || ''
    if (!serviceId) { try { serviceId = fs.readFileSync('.render-service', 'utf8').trim() } catch {} }
    if (!serviceId) serviceId = (await rl.question('Render service id (srv-...): ')).trim()
    if (!serviceId) { log('Service id required.'); rl.close(); process.exit(1) }

    log(`Triggering redeploy of ${serviceId} ...`)
    const dep = await rPOST(key, `/services/${serviceId}/deploys`, {})
    const deployId = dep.id || (dep.deploy && dep.deploy.id)
    const BAD = new Set(['build_failed','update_failed','canceled','deactivated','pre_deploy_failed'])
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 15000))
      const d = await rGET(key, `/services/${serviceId}/deploys/${deployId}`)
      const st = (d.deploy || d).status
      log(`  [${i + 1}] status=${st}`)
      if (st === 'live') { log('DEPLOY LIVE'); break }
      if (BAD.has(st)) { log('Deploy ended: ' + st); break }
    }
    rl.close()
  } catch (e) { log('Deploy failed: ' + (e && e.message || e)); rl.close(); process.exit(1) }
}
main()
