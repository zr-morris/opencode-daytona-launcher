/*
 * OpenCode + Daytona launcher backend
 * -----------------------------------------
 * A small Express service (Render free tier) that launches OpenCode Web
 * inside on-demand Daytona sandboxes, following the official guide:
 * https://www.daytona.io/docs/en/guides/opencode/opencode-web-agent/
 *
 * Env vars:
 *  - DAYTONA_API_KEY (required)
 *  - OPENAI_API_KEY (optional, persisted into each sandbox)
 *  - PORT (injected by Render)
 */

import express, { Request, Response } from 'express'
import { Daytona, Sandbox } from '@daytona/sdk'

const PORT = parseInt(process.env.PORT || '3000', 10)
const OPENCODE_PORT = 3000
const OPENCODE_VERSION = '1.17.3'
const DEFAULT_MODEL = 'opencode/deepseek-v4-flash-free' // DeepSeek V4 Flash Free (no API key required)
// Free-tier Daytona orgs cannot run the default snapshot's linux-vm class.
// Creating from an image runs as the container class, which the free tier allows.
const DAYTONA_TARGET = process.env.DAYTONA_TARGET || 'us'
// node:20 (not -slim) ships git, which OpenCode needs for 'Create Git repository'.
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'node:20'
const APP_LABEL = 'opencode-launcher' // label so we only list/stop sandboxes we created

// Daytona Tier 1 (free, email-verified) shared resource pool.
// Source: https://www.daytona.io/docs/en/limits  (10 vCPU / 10 GiB / 30 GiB)
// Overridable via env in case the account is on a higher tier.
const TIER_CPU = parseInt(process.env.TIER_CPU || '10', 10)
const TIER_MEM = parseInt(process.env.TIER_MEM || '10', 10) // GiB
const TIER_DISK = parseInt(process.env.TIER_DISK || '30', 10) // GiB
const TIER_NAME = process.env.TIER_NAME || 'Free (Tier 1)'
// Per-sandbox footprint this launcher requests (must match daytona.create below).
const SANDBOX_CPU = 1
const SANDBOX_MEM = 2 // GiB
const SANDBOX_DISK = 5 // GiB
const RUNNING_STATES = new Set(['started', 'starting', 'running'])
const DEFAULT_IDLE_MINUTES = parseInt(process.env.DEFAULT_IDLE_MINUTES || '30', 10)

// ---------------------------------------------------------------------------
// BYOK credential model (stateless server).
// Keys are supplied by the browser per-request via X-* headers and are NEVER
// persisted or logged here. For operator convenience, env vars act as optional
// fallbacks when a header is absent. Header always takes precedence over env.
// ---------------------------------------------------------------------------
interface Creds {
  daytonaKey?: string
  daytonaTarget: string
  githubToken?: string
  linearKey?: string
  linearTeam?: string
  renderKey?: string
}

function hdr(req: Request, name: string): string | undefined {
  const v = req.header(name)
  if (v && String(v).trim()) return String(v).trim()
  return undefined
}

function getCreds(req: Request): Creds {
  return {
    daytonaKey: hdr(req, 'X-Daytona-Key') || process.env.DAYTONA_API_KEY || undefined,
    daytonaTarget:
      hdr(req, 'X-Daytona-Target') || process.env.DAYTONA_TARGET || DAYTONA_TARGET,
    githubToken: hdr(req, 'X-GitHub-Token') || process.env.GITHUB_TOKEN || undefined,
    linearKey: hdr(req, 'X-Linear-Key') || process.env.LINEAR_API_KEY || undefined,
    linearTeam: hdr(req, 'X-Linear-Team') || process.env.LINEAR_TEAM_ID || undefined,
    renderKey: hdr(req, 'X-Render-Key') || process.env.RENDER_API_KEY || undefined,
  }
}

// Build a Daytona client from per-request creds, or null if no key is present.
function daytonaFromReq(req: Request): { daytona: Daytona; target: string } | null {
  const c = getCreds(req)
  if (!c.daytonaKey) return null
  return { daytona: new Daytona({ apiKey: c.daytonaKey, target: c.daytonaTarget }), target: c.daytonaTarget }
}

const NO_KEY_MSG = 'No Daytona API key. Add it in Settings.'

// last4 helper for safe logging (never logs the full key)
function last4(v?: string): string { return v ? '...' + v.slice(-4) : '(none)' }

// Generate a shell snippet that injects an env var via base64 (avoids quoting issues).
function injectEnvVar(name: string, content: string): string {
  const b64 = Buffer.from(content).toString('base64')
  return `${name}=$(echo '${b64}' | base64 -d)`
}

// Track launched sandboxes in memory so they can be stopped.
const sandboxes = new Map<string, { url: string; createdAt: string }>()

const app = express()
app.use(express.json())

// --- Health check ---
app.get('/healthz', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'opencode-daytona-launcher',
    statelessByok: true,
    opencodeVersion: OPENCODE_VERSION,
    defaultModel: DEFAULT_MODEL,
    sandboxImage: SANDBOX_IMAGE,
    defaultDaytonaTarget: DAYTONA_TARGET,
    // Optional operator env fallbacks (booleans only; never expose values).
    daytonaEnvFallback: Boolean(process.env.DAYTONA_API_KEY),
    githubEnvFallback: Boolean(process.env.GITHUB_TOKEN),
    linearEnvFallback: Boolean(process.env.LINEAR_API_KEY),
    renderEnvFallback: Boolean(process.env.RENDER_API_KEY),
    activeSandboxes: sandboxes.size,
  })
})

// --- Landing page ---
app.get('/', (_req: Request, res: Response) => {
  res.type('html').send(LANDING_HTML)
})

// --- Launch a new OpenCode Web sandbox ---
app.post('/api/launch', async (req: Request, res: Response) => {
  const creds = getCreds(req)
  if (!creds.daytonaKey) {
    return res.status(400).json({ error: NO_KEY_MSG })
  }

  const daytona = new Daytona({ apiKey: creds.daytonaKey, target: creds.daytonaTarget })
  let sandbox: Sandbox | undefined

  try {
    console.log('[launch] Creating sandbox...')
    console.log('[launch] creds present -> daytona:%s github:%s linear:%s render:%s',
      last4(creds.daytonaKey), Boolean(creds.githubToken), Boolean(creds.linearKey), Boolean(creds.renderKey))
    const envVars: Record<string, string> = {}
    if (process.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY
    // Inject the user's BYOK integration creds so OpenCode can use them.
    if (creds.githubToken) { envVars.GH_TOKEN = creds.githubToken; envVars.GITHUB_TOKEN = creds.githubToken }
    if (creds.linearKey) envVars.LINEAR_API_KEY = creds.linearKey
    if (creds.linearTeam) envVars.LINEAR_TEAM_ID = creds.linearTeam
    if (creds.renderKey) envVars.RENDER_API_KEY = creds.renderKey
    sandbox = await daytona.create(
      {
        image: SANDBOX_IMAGE,
        // public: true removes Daytona's preview interstitial + auth gate so the
        // OpenCode Web URL opens directly in any browser.
        public: true,
        labels: { app: APP_LABEL },
        envVars,
        resources: { cpu: 1, memory: 2, disk: 5 },
      },
      { timeout: 180 },
    )

    console.log('[launch] Installing OpenCode...')
    await sandbox.process.executeCommand(`npm i -g opencode-ai@${OPENCODE_VERSION}`)

    // Build the Daytona preview URL pattern ({PORT} placeholder).
    const previewLink = await sandbox.getPreviewLink(1234)
    const previewUrlPattern = previewLink.url.replace(/1234/, '{PORT}')

    const systemPrompt = [
      'You are running in a Daytona sandbox.',
      'Use the /home/daytona directory instead of /workspace for file operations.',
      'This sandbox is PUBLIC: every port you expose is reachable over the internet with NO login.',
      'Always host websites, static sites, and dev servers INSIDE this current sandbox. Do not attempt to create a separate Daytona sandbox; you do not have credentials to do so.',
      `When you run a service on a port, its public preview URL is exactly this pattern with {PORT} replaced by the real port number: ${previewUrlPattern}`,
      'Always give the user this plain public preview URL. It works in any browser, including mobile, with no Daytona login and no token.',
      `Never give the user a link that requires logging in to Daytona, and never use a signed or authenticated preview URL. Use only the plain ${previewUrlPattern} form.`,
      'Bind servers to host 0.0.0.0 (not 127.0.0.1) so the public preview proxy can reach them. For example: python3 -m http.server 8000 --bind 0.0.0.0, or for vite/node set host 0.0.0.0.',
      'When starting a server, start it in the background with & so the command does not block further instructions, then print the public preview URL for that port.',
    ].join(' ')

    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      model: DEFAULT_MODEL,
      default_agent: 'daytona',
      agent: {
        daytona: {
          description: 'Daytona sandbox-aware coding agent',
          mode: 'primary',
          model: DEFAULT_MODEL,
          prompt: systemPrompt,
        },
      },
    }

    console.log('[launch] Starting OpenCode web server...')
    const configJson = JSON.stringify(opencodeConfig)

    const sessionId = `opencode-session-${Date.now()}`
    await sandbox.process.createSession(sessionId)

    // Ensure git is available and has an identity. OpenCode's "Create Git repository"
    // runs `git init`/`git commit`, which fail if git is missing (e.g. on -slim images)
    // or if user.name/user.email are unset. node:20 ships git; this is belt-and-suspenders.
    await sandbox.process.executeCommand(
      `(command -v git >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1)); ` +
        `git config --global user.name "OpenCode"; ` +
        `git config --global user.email "opencode@daytona.local"; ` +
        `git config --global init.defaultBranch main; ` +
        `git config --global --add safe.directory '*'; ` +
        `true`,
      undefined,
      undefined,
      180,
    )

    // If a GitHub token was provided, configure a credential helper so OpenCode
    // can clone/push over HTTPS without prompting. The token is written to
    // ~/.git-credentials (chmod 600). Passed via base64 so it never appears in
    // the command line or logs.
    if (creds.githubToken) {
      const ghLine = `https://x-access-token:${creds.githubToken}@github.com`
      const ghB64 = Buffer.from(ghLine + '\n').toString('base64')
      try {
        await sandbox.process.executeCommand(
          `git config --global credential.helper store; ` +
            `umask 077; echo '${ghB64}' | base64 -d > "$HOME/.git-credentials"; ` +
            `chmod 600 "$HOME/.git-credentials"; ` +
            `git config --global user.name "OpenCode"; ` +
            `true`,
          undefined,
          undefined,
          60,
        )
        console.log('[launch] GitHub credential helper configured (%s)', last4(creds.githubToken))
      } catch (e: any) {
        console.warn('[launch] GitHub credential setup failed (non-fatal):', e?.message || e)
      }
    }

    const envVar = injectEnvVar('OPENCODE_CONFIG_CONTENT', configJson)

    // Warm up OpenCode's SQLite session DB BEFORE starting the web server.
    // On a fresh sandbox the DB schema is empty; OpenCode runs migrations
    // (ALTER TABLE / CREATE INDEX) on first use. If the web UI opens and fires
    // concurrent requests before migrations finish, the requests race the
    // migration and fail ("Failed query: ALTER TABLE ...", "index ... already
    // exists"), which surfaces as the model failing to respond. Running one
    // serial invocation here applies all migrations to completion first, so the
    // web UI never hits the race. Best-effort: never fail the launch on warmup.
    console.log('[launch] Warming up OpenCode session DB (applies migrations)...')
    try {
      await sandbox.process.executeCommand(
        `mkdir -p /home/daytona; cd /home/daytona; ${envVar} opencode run -m ${DEFAULT_MODEL} "ready" >/tmp/opencode-warmup.log 2>&1; true`,
        undefined,
        undefined,
        120,
      )
    } catch (warmErr: any) {
      console.warn('[launch] Warmup step error (non-fatal):', warmErr?.message || warmErr)
    }

    await sandbox.process.executeSessionCommand(sessionId, {
      command: `${envVar} opencode web --hostname 0.0.0.0 --port ${OPENCODE_PORT}`,
      runAsync: true,
    })

    const opencodePreviewLink = await sandbox.getPreviewLink(OPENCODE_PORT)
    const sandboxId = (sandbox as any).id ?? (sandbox as any).sandboxId ?? 'unknown'

    // Two-stage readiness check before returning the URL, so the link works the
    // instant the user receives it (no HTTP 502 "This page isn't working").
    //
    // Stage 1 (inside): confirm 'opencode web' is bound to the port. Without
    //   this the URL is handed back before the server starts listening.
    // Stage 2 (outside): confirm the PUBLIC preview URL answers through the
    //   Daytona proxy. When a second sandbox comes up, its public preview route
    //   takes a few extra seconds to register at the proxy edge; the localhost
    //   check passes but the public URL still 502s briefly. Probing the public
    //   URL from here waits out that proxy propagation. Best-effort with a cap.
    console.log('[launch] Stage 1: waiting for web server to listen (inside sandbox)...')
    let webReady = false
    for (let i = 0; i < 20; i++) {
      try {
        const probe = await sandbox.process.executeCommand(
          `curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://127.0.0.1:${OPENCODE_PORT}/ 2>/dev/null || echo 000`,
          undefined,
          undefined,
          15,
        )
        const code = String((probe as any).result || '').trim().split('\n').pop()
        if (code === '200') { webReady = true; break }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000))
    }
    console.log(`[launch] Stage 1 (inside) ready: ${webReady}`)

    // Stage 2: probe the public preview URL from the launcher (through the proxy).
    let publicReady = false
    for (let i = 0; i < 20; i++) {
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 6000)
        const resp = await fetch(opencodePreviewLink.url, {
          method: 'GET',
          redirect: 'manual',
          signal: ctl.signal,
        })
        clearTimeout(timer)
        // 200 = ready. 3xx (proxy redirect) also means the route is live.
        if (resp.status === 200 || (resp.status >= 300 && resp.status < 400)) {
          publicReady = true
          break
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000))
    }
    console.log(`[launch] Stage 2 (public proxy) ready: ${publicReady}`)
    const record = { url: opencodePreviewLink.url, createdAt: new Date().toISOString() }
    sandboxes.set(sandboxId, record)

    const previewToken = (opencodePreviewLink as any).token as string | undefined
    console.log(`[launch] Ready: ${opencodePreviewLink.url} (sandbox=${sandboxId})`)
    return res.json({
      ok: true,
      sandboxId,
      url: opencodePreviewLink.url,
      token: previewToken,
      webReady,
      publicReady,
      opencodeVersion: OPENCODE_VERSION,
      defaultModel: DEFAULT_MODEL,
      note: 'OpenCode Web is starting inside the Daytona sandbox. Open the URL; it may take a few seconds to become available. If prompted, the preview token authorizes access to this sandbox.',
    })
  } catch (err: any) {
    console.error('[launch] Error:', err?.message || err)
    // Best-effort cleanup on failure so we do not leak sandboxes.
    try { if (sandbox) await sandbox.delete() } catch {}
    return res.status(500).json({ error: String(err?.message || err) })
  }
})

// --- Stop/delete a sandbox ---
app.post('/api/stop', async (req: Request, res: Response) => {
  const conn = daytonaFromReq(req)
  if (!conn) return res.status(400).json({ error: NO_KEY_MSG })
  const sandboxId = (req.body && req.body.sandboxId) as string | undefined
  if (!sandboxId) return res.status(400).json({ error: 'sandboxId is required' })
  try {
    const daytona = conn.daytona
    const sb = await (daytona as any).get(sandboxId)
    if (sb) await sb.delete()
    sandboxes.delete(sandboxId)
    return res.json({ ok: true, deleted: sandboxId })
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message || err) })
  }
})

// --- Bulk-stop launcher sandboxes that have been idle past a threshold ---
// Idle = running AND lastActivityAt older than idleMinutes (default 30).
// Only ever touches sandboxes labeled app=opencode-launcher.
app.post('/api/stop-idle', async (req: Request, res: Response) => {
  const conn = daytonaFromReq(req)
  if (!conn) return res.status(400).json({ error: NO_KEY_MSG })
  const idleMinutes = Math.max(
    1,
    parseInt(String((req.body && req.body.idleMinutes) ?? DEFAULT_IDLE_MINUTES), 10) || DEFAULT_IDLE_MINUTES,
  )
  const cutoff = Date.now() - idleMinutes * 60_000
  const TERMINAL = new Set(['destroying', 'destroyed', 'archived', 'archiving', 'error'])
  try {
    const daytona = conn.daytona
    const candidates: { id: string; idleMin: number }[] = []
    const kept: { id: string; reason: string }[] = []
    for await (const sb of daytona.list({ labels: { app: APP_LABEL } } as any)) {
      const id = (sb as any).id ?? (sb as any).sandboxId
      const state = String((sb as any).state ?? 'unknown')
      if (TERMINAL.has(state)) continue
      if (!RUNNING_STATES.has(state)) { kept.push({ id, reason: 'not running' }); continue }
      const laRaw = (sb as any).lastActivityAt
      const la = laRaw ? new Date(laRaw).getTime() : null
      if (la == null) { kept.push({ id, reason: 'no lastActivityAt' }); continue }
      const idleMin = Math.round((Date.now() - la) / 60_000)
      if (la <= cutoff) candidates.push({ id, idleMin })
      else kept.push({ id, reason: 'active (' + idleMin + 'm idle)' })
    }
    const stopped: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const c of candidates) {
      try {
        const sb = await (daytona as any).get(c.id)
        if (sb) await sb.delete()
        sandboxes.delete(c.id)
        stopped.push(c.id)
      } catch (e: any) {
        failed.push({ id: c.id, error: String(e?.message || e) })
      }
    }
    return res.json({ ok: true, idleMinutes, stoppedCount: stopped.length, stopped, kept, failed })
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message || err) })
  }
})

// --- List sandboxes created by this launcher (live from Daytona, scoped by label) ---
app.get('/api/sandboxes', async (req: Request, res: Response) => {
  const conn = daytonaFromReq(req)
  if (!conn) return res.status(400).json({ error: NO_KEY_MSG })
  try {
    const daytona = conn.daytona
    const out: any[] = []
    const HIDDEN_STATES = new Set(['destroying', 'destroyed', 'archived', 'archiving', 'error'])
    for await (const sb of daytona.list({ labels: { app: APP_LABEL } } as any)) {
      const id = (sb as any).id ?? (sb as any).sandboxId
      const state = (sb as any).state ?? 'unknown'
      if (HIDDEN_STATES.has(String(state))) continue
      let url = sandboxes.get(id)?.url || ''
      if (!url) {
        try { url = (await sb.getPreviewLink(OPENCODE_PORT)).url } catch {}
      }
      out.push({
        sandboxId: id,
        state,
        public: (sb as any).public ?? null,
        createdAt: (sb as any).createdAt ?? null,
        lastActivityAt: (sb as any).lastActivityAt ?? null,
        cpu: Number((sb as any).cpu ?? 0),
        memory: Number((sb as any).memory ?? 0),
        disk: Number((sb as any).disk ?? 0),
        running: RUNNING_STATES.has(String(state)),
        url,
      })
    }
    // newest first
    out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    res.json({ count: out.length, sandboxes: out })
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// --- Account-wide resource usage vs the free-tier pool (for the dashboard) ---
// Every RUNNING sandbox on the account (any label) counts against the shared
// CPU/memory pool, so we aggregate the whole account, then break out how much
// this launcher specifically is using.
app.get('/api/usage', async (req: Request, res: Response) => {
  const conn = daytonaFromReq(req)
  if (!conn) return res.status(400).json({ error: NO_KEY_MSG })
  try {
    const daytona = conn.daytona
    const TERMINAL = new Set(['destroying', 'destroyed', 'archived', 'archiving', 'error'])
    let total = 0, running = 0, stopped = 0, launcherTotal = 0, launcherRunning = 0
    let usedCpu = 0, usedMem = 0, usedDisk = 0
    let launcherCpu = 0, launcherMem = 0
    const byState: Record<string, number> = {}
    for await (const sb of daytona.list()) {
      const state = String((sb as any).state ?? 'unknown')
      if (TERMINAL.has(state)) continue
      total++
      byState[state] = (byState[state] || 0) + 1
      const isRunning = RUNNING_STATES.has(state)
      const cpu = Number((sb as any).cpu ?? 0)
      const mem = Number((sb as any).memory ?? 0)
      const disk = Number((sb as any).disk ?? 0)
      const isLauncher = ((sb as any).labels && (sb as any).labels.app) === APP_LABEL
      if (isLauncher) launcherTotal++
      if (isRunning) {
        running++
        usedCpu += cpu
        usedMem += mem
        if (isLauncher) { launcherRunning++; launcherCpu += cpu; launcherMem += mem }
      } else {
        stopped++
      }
      // Disk persists for any non-archived sandbox (running or stopped).
      usedDisk += disk
    }
    // How many MORE launcher sandboxes (1cpu/2gib/5disk) fit in remaining pool.
    const freeCpu = Math.max(0, TIER_CPU - usedCpu)
    const freeMem = Math.max(0, TIER_MEM - usedMem)
    const freeDisk = Math.max(0, TIER_DISK - usedDisk)
    const slotsRemaining = Math.max(0, Math.min(
      Math.floor(freeCpu / SANDBOX_CPU),
      Math.floor(freeMem / SANDBOX_MEM),
      Math.floor(freeDisk / SANDBOX_DISK),
    ))
    res.json({
      tier: { name: TIER_NAME, cpu: TIER_CPU, memory: TIER_MEM, disk: TIER_DISK },
      perSandbox: { cpu: SANDBOX_CPU, memory: SANDBOX_MEM, disk: SANDBOX_DISK },
      used: { cpu: usedCpu, memory: usedMem, disk: usedDisk },
      free: { cpu: freeCpu, memory: freeMem, disk: freeDisk },
      counts: { total, running, stopped, launcherTotal, launcherRunning, byState },
      launcherUsed: { cpu: launcherCpu, memory: launcherMem },
      slotsRemaining,
    })
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// ---------------------------------------------------------------------------
// Validation endpoints. Each reads the relevant key (header preferred, body
// fallback) and verifies it with a real lightweight API call. Never logs keys.
// ---------------------------------------------------------------------------
function keyFrom(req: Request, header: string, bodyField: string): string | undefined {
  return hdr(req, header) || (req.body && req.body[bodyField] ? String(req.body[bodyField]).trim() : undefined)
}

async function fetchWithTimeout(url: string, init: any, ms = 8000): Promise<globalThis.Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try { return await fetch(url, { ...init, signal: ctl.signal }) }
  finally { clearTimeout(t) }
}

// Daytona: construct a client and do a cheap list (stop after first item).
app.post('/api/validate/daytona', async (req: Request, res: Response) => {
  const apiKey = keyFrom(req, 'X-Daytona-Key', 'key')
  const target = hdr(req, 'X-Daytona-Target') || (req.body && req.body.target) || DAYTONA_TARGET
  if (!apiKey) return res.status(400).json({ ok: false, error: 'Daytona API key is required.' })
  try {
    const daytona = new Daytona({ apiKey, target })
    // Iterate the async list and immediately break — confirms auth works.
    for await (const _sb of daytona.list()) break
    return res.json({ ok: true, target })
  } catch (err: any) {
    return res.status(200).json({ ok: false, error: 'Invalid Daytona key or unreachable: ' + String(err?.message || err) })
  }
})

// GitHub: GET /user with the PAT.
app.post('/api/validate/github', async (req: Request, res: Response) => {
  const token = keyFrom(req, 'X-GitHub-Token', 'token')
  if (!token) return res.status(400).json({ ok: false, error: 'GitHub token is required.' })
  try {
    const r = await fetchWithTimeout('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'opencode-daytona-launcher',
        Accept: 'application/vnd.github+json',
      },
    })
    if (!r.ok) return res.json({ ok: false, error: 'GitHub rejected the token (HTTP ' + r.status + ').' })
    const u: any = await r.json()
    return res.json({ ok: true, login: u.login, name: u.name, avatarUrl: u.avatar_url })
  } catch (err: any) {
    return res.json({ ok: false, error: 'GitHub validation failed: ' + String(err?.message || err) })
  }
})

// Linear: GraphQL viewer + teams. Personal API key uses Authorization: <key> (no Bearer).
app.post('/api/validate/linear', async (req: Request, res: Response) => {
  const key = keyFrom(req, 'X-Linear-Key', 'key')
  if (!key) return res.status(400).json({ ok: false, error: 'Linear API key is required.' })
  try {
    const r = await fetchWithTimeout('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query: '{ viewer { id name email } teams { nodes { id name key } } }' }),
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok || data.errors) {
      const msg = data.errors ? data.errors.map((e: any) => e.message).join('; ') : 'HTTP ' + r.status
      return res.json({ ok: false, error: 'Linear rejected the key: ' + msg })
    }
    const viewer = data?.data?.viewer || {}
    const teams = (data?.data?.teams?.nodes || []).map((t: any) => ({ id: t.id, name: t.name, key: t.key }))
    return res.json({ ok: true, viewer: { name: viewer.name, email: viewer.email }, teams })
  } catch (err: any) {
    return res.json({ ok: false, error: 'Linear validation failed: ' + String(err?.message || err) })
  }
})

// Render: GET /v1/owners.
app.post('/api/validate/render', async (req: Request, res: Response) => {
  const key = keyFrom(req, 'X-Render-Key', 'key')
  if (!key) return res.status(400).json({ ok: false, error: 'Render API key is required.' })
  try {
    const r = await fetchWithTimeout('https://api.render.com/v1/owners?limit=1', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    })
    if (!r.ok) return res.json({ ok: false, error: 'Render rejected the key (HTTP ' + r.status + ').' })
    const arr: any = await r.json()
    const owners = (Array.isArray(arr) ? arr : []).map((x: any) => {
      const o = x.owner || x
      return { id: o.id, name: o.name, type: o.type }
    })
    return res.json({ ok: true, owners })
  } catch (err: any) {
    return res.json({ ok: false, error: 'Render validation failed: ' + String(err?.message || err) })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`opencode-daytona-launcher listening on 0.0.0.0:${PORT}`)
  console.log('Stateless BYOK mode. Env fallbacks -> daytona:%s github:%s linear:%s render:%s',
    Boolean(process.env.DAYTONA_API_KEY), Boolean(process.env.GITHUB_TOKEN),
    Boolean(process.env.LINEAR_API_KEY), Boolean(process.env.RENDER_API_KEY))
})

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenCode on Daytona</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0d10; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 20px; }
  .card { width: 100%; max-width: 860px; padding: 32px; border: 1px solid #222; border-radius: 12px; background: #111418; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  h2 { font-size: 14px; color: #9a9a9a; margin: 28px 0 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  p { color: #aaa; line-height: 1.5; }
  button { background: #3ddc84; color: #002; border: 0; padding: 12px 20px; font-size: 15px; border-radius: 8px; cursor: pointer; font-weight: 700; font-family: inherit; }
  button[disabled] { opacity: 0.6; cursor: wait; }
  .btn-sm { padding: 6px 12px; font-size: 13px; }
  .btn-stop { background: #ff5c5c; color: #fff; }
  .btn-ghost { background: transparent; color: #9a9a9a; border: 1px solid #333; }
  #out { margin-top: 20px; padding: 14px; background: #0d1115; border: 1px solid #222; border-radius: 8px; word-break: break-all; display: none; }
  a { color: #3ddc84; }
  .row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid #222; border-radius: 8px; margin-bottom: 8px; background: #0d1115; }
  .row .meta { flex: 1; min-width: 0; }
  .row .id { font-size: 13px; color: #ddd; }
  .row .sub { font-size: 11px; color: #808080; margin-top: 2px; }
  .pill { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: #1e262e; color: #7cc5ff; }
  .muted { color: #707070; font-size: 13px; }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .row .url { display: block; font-size: 12px; color: #3ddc84; margin-top: 4px; word-break: break-all; }
  .row .url:hover { text-decoration: underline; }
  .row .actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .btn-copy { background: transparent; color: #7cc5ff; border: 1px solid #2a3a48; }
  .btn-warn { background: transparent; color: #ffc857; border: 1px solid #4a3a1f; }
  .copied { color: #3ddc84 !important; border-color: #2a4a32 !important; }
  /* ---- dashboard ---- */
  .dash { margin: 20px 0 8px; }
  .hero { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .hero .big { font-size: 34px; font-weight: 800; line-height: 1; }
  .hero .big.ok { color: #3ddc84; } .hero .big.warn { color: #ffc857; } .hero .big.full { color: #ff5c5c; }
  .hero .lbl { color: #9a9a9a; font-size: 13px; }
  .tierTag { font-size: 10px; padding: 3px 8px; border-radius: 10px; background: #14241c; color: #3ddc84; border: 1px solid #234; letter-spacing: .04em; }
  .gauges { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 620px) { .gauges { grid-template-columns: 1fr; } }
  .gauge { padding: 14px; border: 1px solid #222; border-radius: 10px; background: #0d1115; }
  .gauge .gtop { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .gauge .gname { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #9a9a9a; }
  .gauge .gval { font-size: 13px; color: #ddd; } .gauge .gval b { color: #fff; }
  .track { height: 10px; border-radius: 6px; background: #1a2027; overflow: hidden; }
  .fill { height: 100%; width: 0%; border-radius: 6px; transition: width .5s ease, background .3s ease; }
  .fill.ok { background: linear-gradient(90deg,#2fb96b,#3ddc84); }
  .fill.warn { background: linear-gradient(90deg,#e0a83a,#ffc857); }
  .fill.full { background: linear-gradient(90deg,#d6453f,#ff6b6b); }
  .gauge .gpct { font-size: 11px; color: #808080; margin-top: 6px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 14px; }
  @media (max-width: 620px) { .stats { grid-template-columns: repeat(2, 1fr); } }
  .stat { padding: 12px 14px; border: 1px solid #222; border-radius: 10px; background: #0d1115; text-align: center; }
  .stat .n { font-size: 24px; font-weight: 800; color: #fff; } .stat .k { font-size: 11px; color: #909090; margin-top: 2px; }
  .res { display: inline-flex; gap: 8px; font-size: 10px; color: #8aa; margin-top: 4px; }
  .res span { background: #121a20; border: 1px solid #1f2a32; padding: 1px 6px; border-radius: 6px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.run { background: #3ddc84; } .dot.stop { background: #ffc857; } .dot.other { background: #6a7886; }
  /* ---- onboarding gate ---- */
  .gate { width: 100%; max-width: 460px; padding: 32px; border: 1px solid #222; border-radius: 12px; background: #111418; }
  .gate h1 { font-size: 20px; margin: 0 0 6px; }
  .gate .lead { color: #9aa; font-size: 13px; line-height: 1.55; margin: 0 0 20px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #8a8a8a; margin-bottom: 6px; }
  .inwrap { position: relative; display: flex; }
  input[type=password], input[type=text], select { width: 100%; box-sizing: border-box; background: #0c1014; border: 1px solid #283039; color: #e6e6e6; border-radius: 8px; padding: 11px 40px 11px 12px; font-family: inherit; font-size: 14px; }
  input:focus, select:focus { outline: none; border-color: #3ddc84; }
  select { padding-right: 12px; }
  .eye { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: transparent; border: 0; color: #7a8794; cursor: pointer; padding: 4px; font-size: 12px; }
  .err { color: #ff6b6b; font-size: 12px; margin-top: 8px; min-height: 14px; }
  .gate .full { width: 100%; margin-top: 4px; }
  .hintlink { font-size: 12px; margin-top: 14px; }
  /* ---- top status strip ---- */
  .topbar { display: flex; align-items: center; justify-content: space-between; margin: -8px 0 10px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; padding: 4px 9px; border-radius: 999px; border: 1px solid #283039; background: #0d1115; color: #9aa; }
  .chip .cdot { width: 7px; height: 7px; border-radius: 50%; background: #5a6672; }
  .chip.on { color: #cfe; border-color: #234734; } .chip.on .cdot { background: #3ddc84; }
  .gear { background: transparent; border: 1px solid #2a3038; color: #cdd; border-radius: 8px; padding: 7px 10px; cursor: pointer; font-size: 13px; }
  .gear:hover { border-color: #3ddc84; color: #fff; }
  /* ---- settings drawer ---- */
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.55); opacity: 0; pointer-events: none; transition: opacity .2s ease; z-index: 40; }
  .scrim.open { opacity: 1; pointer-events: auto; }
  .drawer { position: fixed; top: 0; right: 0; height: 100%; width: 440px; max-width: 92vw; background: #0e1216; border-left: 1px solid #222; transform: translateX(100%); transition: transform .25s ease; z-index: 50; overflow-y: auto; box-sizing: border-box; padding: 22px; }
  .drawer.open { transform: translateX(0); }
  .drawer h2 { margin: 0; font-size: 16px; color: #e6e6e6; text-transform: none; letter-spacing: 0; }
  .drawer .dhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .closex { background: transparent; border: 0; color: #9aa; font-size: 20px; cursor: pointer; line-height: 1; padding: 4px; }
  .closex:hover { color: #fff; }
  .disclosure { font-size: 11px; color: #7a8794; line-height: 1.5; background: #0c1014; border: 1px solid #1d242b; border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; }
  .intg { border: 1px solid #222; border-radius: 10px; background: #0d1115; padding: 14px; margin-bottom: 12px; }
  .intg .ihead { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .intg .iname { font-size: 14px; font-weight: 700; color: #e6e6e6; }
  .req { font-size: 9px; color: #3ddc84; border: 1px solid #234734; border-radius: 999px; padding: 1px 6px; text-transform: uppercase; letter-spacing: .04em; }
  .opt { font-size: 9px; color: #7a8794; border: 1px solid #2a3038; border-radius: 999px; padding: 1px 6px; text-transform: uppercase; letter-spacing: .04em; }
  .intg .idesc { font-size: 12px; color: #8a96a2; line-height: 1.45; margin: 0 0 10px; }
  .badge { font-size: 11px; padding: 3px 9px; border-radius: 999px; display: inline-flex; align-items: center; gap: 6px; }
  .badge.b-off { background: #15191e; color: #8a8a8a; border: 1px solid #2a3038; }
  .badge.b-on { background: #10241a; color: #3ddc84; border: 1px solid #234734; }
  .badge.b-bad { background: #2a1414; color: #ff6b6b; border: 1px solid #4a2222; }
  .irow { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .saved { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #cdd; }
  .ava { width: 24px; height: 24px; border-radius: 50%; border: 1px solid #2a3038; }
  .btn-primary2 { background: #3ddc84; color: #002; border: 0; padding: 8px 14px; border-radius: 8px; font-weight: 700; cursor: pointer; font-family: inherit; font-size: 13px; }
  .btn-line { background: transparent; color: #cdd; border: 1px solid #2a3038; padding: 7px 12px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px; }
  .btn-line:hover { border-color: #3ddc84; }
  .btn-danger { background: transparent; color: #ff6b6b; border: 1px solid #4a2222; padding: 7px 12px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px; }
  .hide { display: none !important; }
</style>
</head>
<body>
<!-- Onboarding gate: shown until a valid Daytona key is set -->
<div id="gate" class="gate hide">
  <h1>Welcome to OpenCode on Daytona</h1>
  <p class="lead">This launcher spins up the OpenCode AI coding agent inside on-demand Daytona sandboxes. To get started, connect your Daytona account. Your key is stored only in this browser and sent directly to Daytona &mdash; this server never stores it.</p>
  <div class="field">
    <label for="gateKey">Daytona API key</label>
    <div class="inwrap">
      <input id="gateKey" type="password" placeholder="dtn_..." autocomplete="off" />
      <button type="button" class="eye" onclick="toggleEye('gateKey', this)">show</button>
    </div>
  </div>
  <div class="field">
    <label for="gateTarget">Region</label>
    <select id="gateTarget"><option value="us">us</option><option value="eu">eu</option></select>
  </div>
  <button id="gateBtn" class="btn-primary2 full" onclick="gateValidate()">Validate &amp; Continue</button>
  <div id="gateErr" class="err"></div>
  <div class="hintlink"><a href="https://app.daytona.io" target="_blank" rel="noopener">Where do I get a Daytona API key?</a> <span class="muted">&middot; free tier available</span></div>
</div>

<div id="app" class="card hide">
  <div class="topbar">
    <div class="chips" id="chips">
      <span class="chip" id="chip-daytona"><span class="cdot"></span>Daytona</span>
      <span class="chip" id="chip-github"><span class="cdot"></span>GitHub</span>
      <span class="chip" id="chip-linear"><span class="cdot"></span>Linear</span>
      <span class="chip" id="chip-render"><span class="cdot"></span>Render</span>
    </div>
    <button class="gear" onclick="openDrawer()">&#9881; Settings</button>
  </div>
  <h1>OpenCode on Daytona <span id="tierTag" class="tierTag">free tier</span></h1>
  <p>Launch the <strong>OpenCode</strong> AI coding agent inside on-demand <strong>Daytona</strong> sandboxes. Each running sandbox gets its own preview link &mdash; the dashboard below shows how much of your free-tier quota is in use.</p>
  <div class="bar">
    <button id="go" onclick="launch()">Launch OpenCode Web</button>
    <span id="slotsHint" class="muted"></span>
  </div>
  <div id="out"></div>

  <div class="dash">
    <div class="hero">
      <span id="slotsBig" class="big ok">&middot;</span>
      <span class="lbl" id="slotsLbl">more instances fit in your free-tier quota</span>
    </div>
    <div class="gauges">
      <div class="gauge">
        <div class="gtop"><span class="gname">vCPU</span><span class="gval"><b id="cpuUsed">-</b> / <span id="cpuMax">-</span></span></div>
        <div class="track"><div id="cpuFill" class="fill ok"></div></div>
        <div class="gpct" id="cpuPct"></div>
      </div>
      <div class="gauge">
        <div class="gtop"><span class="gname">Memory</span><span class="gval"><b id="memUsed">-</b> / <span id="memMax">-</span> GiB</span></div>
        <div class="track"><div id="memFill" class="fill ok"></div></div>
        <div class="gpct" id="memPct"></div>
      </div>
      <div class="gauge">
        <div class="gtop"><span class="gname">Disk</span><span class="gval"><b id="diskUsed">-</b> / <span id="diskMax">-</span> GiB</span></div>
        <div class="track"><div id="diskFill" class="fill ok"></div></div>
        <div class="gpct" id="diskPct"></div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="n" id="stTotal">-</div><div class="k">Total sandboxes</div></div>
      <div class="stat"><div class="n" id="stRunning">-</div><div class="k"><span class="dot run"></span>Running</div></div>
      <div class="stat"><div class="n" id="stStopped">-</div><div class="k"><span class="dot stop"></span>Stopped</div></div>
      <div class="stat"><div class="n" id="stLauncher">-</div><div class="k">OpenCode (this app)</div></div>
    </div>
  </div>

  <h2>Active OpenCode sandboxes</h2>
  <div class="bar" style="margin-bottom: 12px">
    <button class="btn-sm btn-ghost" onclick="refreshAll()">Refresh</button>
    <button id="stopIdleBtn" class="btn-sm btn-warn" onclick="stopIdle()">Stop all idle</button>
    <span id="listStatus" class="muted"></span>
  </div>
  <div id="list"></div>
</div>
<script>
// ---- BYOK key storage (browser localStorage only; never sent anywhere but the APIs) ----
var LS = {
  daytonaKey: 'ocdl_daytona_key',
  daytonaTarget: 'ocdl_daytona_target',
  githubToken: 'ocdl_github_token',
  linearKey: 'ocdl_linear_key',
  linearTeam: 'ocdl_linear_team',
  renderKey: 'ocdl_render_key',
}
function lsGet(k) { try { return localStorage.getItem(k) || '' } catch (e) { return '' } }
function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k) } catch (e) {} }
function authHeaders(extra) {
  var h = extra || {}
  var dk = lsGet(LS.daytonaKey); if (dk) h['X-Daytona-Key'] = dk
  var dt = lsGet(LS.daytonaTarget); if (dt) h['X-Daytona-Target'] = dt
  var gh = lsGet(LS.githubToken); if (gh) h['X-GitHub-Token'] = gh
  var lk = lsGet(LS.linearKey); if (lk) h['X-Linear-Key'] = lk
  var lt = lsGet(LS.linearTeam); if (lt) h['X-Linear-Team'] = lt
  var rk = lsGet(LS.renderKey); if (rk) h['X-Render-Key'] = rk
  return h
}
function last4(v) { return v ? '\u2022\u2022\u2022\u2022 ' + v.slice(-4) : '' }

// ---- integration config: maps provider -> localStorage key + validate route ----
var INTG = {
  daytona: { ls: LS.daytonaKey, route: '/api/validate/daytona', label: 'Daytona' },
  github:  { ls: LS.githubToken, route: '/api/validate/github', label: 'GitHub' },
  linear:  { ls: LS.linearKey, route: '/api/validate/linear', label: 'Linear' },
  render:  { ls: LS.renderKey, route: '/api/validate/render', label: 'Render' },
}

function toggleEye(id, btn) {
  var el = document.getElementById(id)
  if (!el) return
  if (el.type === 'password') { el.type = 'text'; btn.textContent = 'hide' }
  else { el.type = 'password'; btn.textContent = 'show' }
}

function setBadge(p, state, text) {
  var b = document.getElementById('b-' + p)
  if (!b) return
  b.className = 'badge ' + (state === 'on' ? 'b-on' : state === 'bad' ? 'b-bad' : 'b-off')
  b.textContent = text || (state === 'on' ? 'Connected' : state === 'bad' ? 'Invalid' : 'Not connected')
}
function setChip(p, on) {
  var c = document.getElementById('chip-' + p)
  if (c) c.className = 'chip' + (on ? ' on' : '')
}

// Show the "saved" summary (masked key + details) vs the edit input for a provider.
function showSaved(p, html) {
  document.getElementById('saved-' + p).innerHTML = html
  document.getElementById('saved-' + p).classList.remove('hide')
  document.getElementById('edit-' + p).classList.add('hide')
  var rep = document.getElementById('rep-' + p); if (rep) rep.classList.remove('hide')
  var dis = document.getElementById('dis-' + p); if (dis) dis.classList.remove('hide')
}
function showEdit(p) {
  document.getElementById('saved-' + p).classList.add('hide')
  document.getElementById('edit-' + p).classList.remove('hide')
  var rep = document.getElementById('rep-' + p); if (rep) rep.classList.add('hide')
  var dis = document.getElementById('dis-' + p); if (dis) dis.classList.add('hide')
}

function openDrawer() { document.getElementById('drawer').classList.add('open'); document.getElementById('scrim').classList.add('open') }
function closeDrawer() { document.getElementById('drawer').classList.remove('open'); document.getElementById('scrim').classList.remove('open') }

// Validate a key against its route; returns the JSON (or {ok:false}).
async function validateKey(p, key, extraHeaders) {
  var headers = extraHeaders || {}
  headers['Content-Type'] = 'application/json'
  if (p === 'daytona') headers['X-Daytona-Key'] = key
  if (p === 'github') headers['X-GitHub-Token'] = key
  if (p === 'linear') headers['X-Linear-Key'] = key
  if (p === 'render') headers['X-Render-Key'] = key
  try {
    var r = await fetch(INTG[p].route, { method: 'POST', headers: headers, body: '{}' })
    return await r.json()
  } catch (e) { return { ok: false, error: String(e && e.message || e) } }
}

// Render the populated/connected state for a provider from a validation result.
function renderConnected(p, key, data) {
  setBadge(p, 'on'); setChip(p, true)
  if (p === 'daytona') {
    showSaved(p, '<span>' + last4(key) + '</span><span class="muted">region ' + (lsGet(LS.daytonaTarget) || 'us') + '</span>')
  } else if (p === 'github') {
    var av = data.avatarUrl ? '<img class="ava" src="' + data.avatarUrl + '" alt="" />' : ''
    showSaved(p, av + '<span>' + (data.login ? '@' + data.login : last4(key)) + (data.name ? ' \u00b7 ' + data.name : '') + '</span>')
  } else if (p === 'render') {
    var o = (data.owners && data.owners[0]) || {}
    showSaved(p, '<span>' + last4(key) + '</span><span class="muted">' + (o.name ? o.name + ' (' + (o.type||'') + ')' : 'connected') + '</span>')
  } else if (p === 'linear') {
    var nm = (data.viewer && data.viewer.name) ? data.viewer.name : ''
    showSaved(p, '<span>' + last4(key) + '</span><span class="muted">' + (nm || 'connected') + '</span>')
    populateLinearTeams(data.teams || [])
  }
}

function populateLinearTeams(teams) {
  var wrap = document.getElementById('team-linear')
  var sel = document.getElementById('in-linear-team')
  if (!teams.length) { wrap.classList.add('hide'); return }
  var cur = lsGet(LS.linearTeam)
  sel.innerHTML = teams.map(function (t) {
    return '<option value="' + t.id + '"' + (t.id === cur ? ' selected' : '') + '>' + t.name + ' (' + t.key + ')</option>'
  }).join('')
  wrap.classList.remove('hide')
  // If no team chosen yet, default to first and persist.
  if (!cur && teams[0]) { lsSet(LS.linearTeam, teams[0].id); sel.value = teams[0].id }
}
function saveLinearTeam() {
  var sel = document.getElementById('in-linear-team')
  lsSet(LS.linearTeam, sel.value)
}

// Test & Save button for any provider in the drawer.
async function testSave(p) {
  var input = document.getElementById('in-' + p)
  var key = (input.value || '').trim()
  var errEl = document.getElementById('err-' + p)
  errEl.textContent = ''
  if (!key) { errEl.textContent = 'Enter a key first.'; return }
  setBadge(p, 'off', 'Testing...')
  var extra = {}
  if (p === 'daytona') { var t = document.getElementById('in-daytona-target'); if (t) extra['X-Daytona-Target'] = t.value }
  var data = await validateKey(p, key, extra)
  if (!data.ok) { setBadge(p, 'bad'); setChip(p, p === 'daytona' ? false : false); errEl.textContent = data.error || 'Validation failed.'; return }
  // Persist + render connected.
  lsSet(INTG[p].ls, key)
  if (p === 'daytona') { var tv = document.getElementById('in-daytona-target'); if (tv) lsSet(LS.daytonaTarget, tv.value) }
  input.value = ''
  renderConnected(p, key, data)
}

function replaceKey(p) { showEdit(p) }
function disconnect(p) {
  lsSet(INTG[p].ls, '')
  if (p === 'linear') lsSet(LS.linearTeam, '')
  setBadge(p, 'off'); setChip(p, false)
  showEdit(p)
  document.getElementById('err-' + p).textContent = ''
  // Daytona disconnect returns user to the gate.
  if (p === 'daytona') location.reload()
}

// On drawer open / boot, reflect stored keys (without re-validating heavy ones,
// except we re-validate to fetch details like github login / linear teams).
async function hydrateDrawer() {
  for (var p in INTG) {
    var key = lsGet(INTG[p].ls)
    if (!key) { setBadge(p, 'off'); setChip(p, false); showEdit(p); continue }
    setBadge(p, 'off', 'Checking...')
    var extra = {}
    if (p === 'daytona') extra['X-Daytona-Target'] = lsGet(LS.daytonaTarget) || 'us'
    var data = await validateKey(p, key, extra)
    if (data.ok) { renderConnected(p, key, data) }
    else { setBadge(p, 'bad'); setChip(p, false); showEdit(p) }
  }
}

// ---- onboarding gate ----
function showGate() {
  document.getElementById('gate').classList.remove('hide')
  document.getElementById('app').classList.add('hide')
}
function showApp() {
  document.getElementById('gate').classList.add('hide')
  document.getElementById('app').classList.remove('hide')
  refreshAll()
  hydrateDrawer()
}
async function gateValidate() {
  var btn = document.getElementById('gateBtn')
  var key = (document.getElementById('gateKey').value || '').trim()
  var target = document.getElementById('gateTarget').value || 'us'
  var err = document.getElementById('gateErr')
  err.textContent = ''
  if (!key) { err.textContent = 'Enter your Daytona API key.'; return }
  btn.disabled = true; btn.textContent = 'Validating...'
  var data = await validateKey('daytona', key, { 'X-Daytona-Target': target })
  btn.disabled = false; btn.textContent = 'Validate & Continue'
  if (!data.ok) { err.textContent = data.error || 'Invalid key.'; return }
  lsSet(LS.daytonaKey, key); lsSet(LS.daytonaTarget, target)
  showApp()
}

// ---- boot: decide gate vs app ----
async function boot() {
  var key = lsGet(LS.daytonaKey)
  if (!key) { showGate(); return }
  // Pre-fill gate target select from storage.
  var gt = document.getElementById('gateTarget'); if (gt) gt.value = lsGet(LS.daytonaTarget) || 'us'
  var dt = document.getElementById('in-daytona-target'); if (dt) dt.value = lsGet(LS.daytonaTarget) || 'us'
  // Validate stored key; if good show app, else gate (prefilled).
  var data = await validateKey('daytona', key, { 'X-Daytona-Target': lsGet(LS.daytonaTarget) || 'us' })
  if (data.ok) { showApp() }
  else { document.getElementById('gateKey').value = ''; showGate(); document.getElementById('gateErr').textContent = 'Saved Daytona key is no longer valid. Please re-enter.' }
}

async function launch() {
  const btn = document.getElementById('go')
  const out = document.getElementById('out')
  btn.disabled = true
  btn.textContent = 'Launching sandbox... (~30-60s)'
  out.style.display = 'block'
  out.textContent = 'Creating Daytona sandbox, installing OpenCode, starting web server...'
  try {
    const r = await fetch('/api/launch', { method: 'POST', headers: authHeaders() })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Launch failed')
    out.innerHTML = 'OpenCode Web is ready!<br><br><a href="' + d.url + '" target="_blank" rel="noopener">' + d.url + '</a>' + '<br><br><span class="muted">All your running instances and their links are listed below under <b>Active OpenCode sandboxes</b>.</span>'
    btn.textContent = 'Launch another'
    refreshAll()
  } catch (e) {
    out.textContent = 'Error: ' + (e.message || e)
    btn.textContent = 'Try again'
  } finally {
    btn.disabled = false
  }
}

function short(id) { return (id || '').slice(0, 8) }
function age(iso) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return Math.floor(s) + 's ago'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  return Math.floor(s / 3600) + 'h ago'
}

function level(pct) { return pct >= 90 ? 'full' : (pct >= 70 ? 'warn' : 'ok') }

function paintGauge(prefix, used, max, unit) {
  var pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0
  var lvl = level(pct)
  document.getElementById(prefix + 'Used').textContent = used
  document.getElementById(prefix + 'Max').textContent = max
  var fill = document.getElementById(prefix + 'Fill')
  fill.style.width = pct + '%'
  fill.className = 'fill ' + lvl
  document.getElementById(prefix + 'Pct').textContent = pct + '% used  \\u00b7  ' + Math.max(0, max - used) + ' ' + unit + ' free'
}

async function loadUsage() {
  try {
    const r = await fetch('/api/usage', { headers: authHeaders() })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'usage failed')

    // tier tag
    document.getElementById('tierTag').textContent = d.tier.name

    // slots headline
    var slots = d.slotsRemaining
    var big = document.getElementById('slotsBig')
    big.textContent = slots
    big.className = 'big ' + (slots === 0 ? 'full' : (slots <= 1 ? 'warn' : 'ok'))
    var lbl = document.getElementById('slotsLbl')
    lbl.textContent = (slots === 1 ? 'more instance fits' : 'more instances fit') +
      ' in your ' + d.tier.name + ' quota (' + d.perSandbox.cpu + ' vCPU / ' + d.perSandbox.memory + ' GiB each)'
    var hint = document.getElementById('slotsHint')
    hint.textContent = slots > 0 ? ('room for ' + slots + ' more') : 'quota full \\u2014 stop one to free space'

    // gauges
    paintGauge('cpu', d.used.cpu, d.tier.cpu, 'vCPU')
    paintGauge('mem', d.used.memory, d.tier.memory, 'GiB')
    paintGauge('disk', d.used.disk, d.tier.disk, 'GiB')

    // stat cards
    document.getElementById('stTotal').textContent = d.counts.total
    document.getElementById('stRunning').textContent = d.counts.running
    document.getElementById('stStopped').textContent = d.counts.stopped
    document.getElementById('stLauncher').textContent = d.counts.launcherTotal
  } catch (e) {
    document.getElementById('slotsLbl').textContent = 'Could not load quota: ' + (e.message || e)
  }
}

async function refreshAll() {
  await Promise.all([loadUsage(), refresh()])
}

async function refresh() {
  const list = document.getElementById('list')
  const status = document.getElementById('listStatus')
  status.textContent = 'loading...'
  try {
    const r = await fetch('/api/sandboxes', { headers: authHeaders() })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Failed to list')
    const items = d.sandboxes || []
    status.textContent = items.length + ' sandbox' + (items.length === 1 ? '' : 'es')
    if (!items.length) {
      list.innerHTML = '<p class="muted">No active sandboxes.</p>'
      return
    }
    list.innerHTML = items.map(function (s) {
      var urlBlock = s.url
        ? '<a class="url" href="' + s.url + '" target="_blank" rel="noopener">' + s.url + '</a>'
        : '<div class="sub" style="color:#c08">no preview url yet</div>'
      var copyBtn = s.url
        ? '<button class="btn-sm btn-copy" onclick="copyUrl(this, \\'' + s.url + '\\')">Copy link</button>'
        : ''
      var dotClass = s.running ? 'run' : (String(s.state) === 'stopped' ? 'stop' : 'other')
      var resChips = '<span class="res">' +
        '<span>' + (s.cpu || 0) + ' vCPU</span>' +
        '<span>' + (s.memory || 0) + ' GiB</span>' +
        '<span>' + (s.disk || 0) + ' GiB disk</span>' +
        '</span>'
      return '<div class="row">' +
        '<div class="meta">' +
          '<div class="id"><span class="dot ' + dotClass + '"></span>' + short(s.sandboxId) + ' <span class="pill">' + (s.state || '') + '</span> <span class="sub" style="margin-left:6px">' + age(s.createdAt) + '</span></div>' +
          urlBlock +
          '<div>' + resChips + '</div>' +
        '</div>' +
        '<div class="actions">' + copyBtn +
          '<button class="btn-sm btn-stop" onclick="stop(\\'' + s.sandboxId + '\\', this)">Stop</button>' +
        '</div>' +
        '</div>'
    }).join('')
  } catch (e) {
    status.textContent = ''
    list.innerHTML = '<p class="muted">Could not load sandboxes: ' + (e.message || e) + '</p>'
  }
}

async function stop(id, btn) {
  if (!confirm('Stop and delete sandbox ' + short(id) + '? This cannot be undone.')) return
  btn.disabled = true
  btn.textContent = 'Stopping...'
  try {
    const r = await fetch('/api/stop', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sandboxId: id }) })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Stop failed')
    refreshAll()
  } catch (e) {
    alert('Error stopping sandbox: ' + (e.message || e))
    btn.disabled = false
    btn.textContent = 'Stop'
  }
}

var IDLE_MINUTES = 30
async function stopIdle() {
  var btn = document.getElementById('stopIdleBtn')
  if (!confirm('Stop and DELETE all OpenCode sandboxes idle for more than ' + IDLE_MINUTES + ' minutes?\\n\\nThis frees quota and cannot be undone. Active sandboxes are left running.')) return
  btn.disabled = true
  var prev = btn.textContent
  btn.textContent = 'Stopping idle...'
  try {
    var r = await fetch('/api/stop-idle', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ idleMinutes: IDLE_MINUTES }) })
    var d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Stop-idle failed')
    var n = d.stoppedCount || 0
    var msg = n === 0 ? 'No idle sandboxes to stop (nothing idle > ' + IDLE_MINUTES + 'm).' : ('Stopped ' + n + ' idle sandbox' + (n === 1 ? '' : 'es') + '.')
    if (d.failed && d.failed.length) msg += ' ' + d.failed.length + ' failed.'
    alert(msg)
  } catch (e) {
    alert('Error: ' + (e.message || e))
  } finally {
    btn.disabled = false
    btn.textContent = prev
    refreshAll()
  }
}

function copyUrl(btn, url) {
  function done() {
    var prev = btn.textContent
    btn.textContent = 'Copied!'
    btn.classList.add('copied')
    setTimeout(function () { btn.textContent = prev; btn.classList.remove('copied') }, 1500)
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(function () { window.prompt('Copy this link:', url) })
  } else {
    window.prompt('Copy this link:', url)
  }
}

// Boot: show gate or app based on stored Daytona key validity.
boot()
// Auto-refresh the dashboard + list every 15s, but only when the app is unlocked.
setInterval(function () {
  var app = document.getElementById('app')
  if (app && !app.classList.contains('hide')) refreshAll()
}, 15000)
</script>

<!-- Settings drawer -->
<div id="scrim" class="scrim" onclick="closeDrawer()"></div>
<div id="drawer" class="drawer" role="dialog" aria-label="Integrations">
  <div class="dhead">
    <h2>Integrations</h2>
    <button class="closex" onclick="closeDrawer()">&times;</button>
  </div>
  <div class="disclosure">Your keys are stored only in this browser (localStorage) and sent directly to your own Daytona / GitHub / Linear / Render. This server never stores them.</div>

  <!-- Daytona -->
  <div class="intg">
    <div class="ihead"><span class="iname">Daytona</span><span class="req">required</span><span id="b-daytona" class="badge b-off" style="margin-left:auto">Not connected</span></div>
    <p class="idesc">Spins up the sandboxes that run OpenCode. This is the access key for the whole app.</p>
    <div id="saved-daytona" class="saved hide"></div>
    <div id="edit-daytona">
      <div class="inwrap"><input id="in-daytona" type="password" placeholder="dtn_..." autocomplete="off" /><button type="button" class="eye" onclick="toggleEye('in-daytona', this)">show</button></div>
      <div class="field" style="margin-top:8px"><label for="in-daytona-target">Region</label><select id="in-daytona-target"><option value="us">us</option><option value="eu">eu</option></select></div>
    </div>
    <div class="irow">
      <button class="btn-primary2" onclick="testSave('daytona')">Test &amp; Save</button>
      <button id="rep-daytona" class="btn-line hide" onclick="replaceKey('daytona')">Replace</button>
      <button id="dis-daytona" class="btn-danger hide" onclick="disconnect('daytona')">Disconnect</button>
    </div>
    <div id="err-daytona" class="err"></div>
  </div>

  <!-- GitHub -->
  <div class="intg">
    <div class="ihead"><span class="iname">GitHub</span><span class="opt">optional</span><span id="b-github" class="badge b-off" style="margin-left:auto">Not connected</span></div>
    <p class="idesc">Lets OpenCode clone, commit, and push to your GitHub repos, and open PRs.</p>
    <div id="saved-github" class="saved hide"></div>
    <div id="edit-github">
      <div class="inwrap"><input id="in-github" type="password" placeholder="ghp_... or github_pat_..." autocomplete="off" /><button type="button" class="eye" onclick="toggleEye('in-github', this)">show</button></div>
    </div>
    <div class="irow">
      <button class="btn-primary2" onclick="testSave('github')">Test &amp; Save</button>
      <button id="rep-github" class="btn-line hide" onclick="replaceKey('github')">Replace</button>
      <button id="dis-github" class="btn-danger hide" onclick="disconnect('github')">Disconnect</button>
    </div>
    <div id="err-github" class="err"></div>
  </div>

  <!-- Linear -->
  <div class="intg">
    <div class="ihead"><span class="iname">Linear</span><span class="opt">optional</span><span id="b-linear" class="badge b-off" style="margin-left:auto">Not connected</span></div>
    <p class="idesc">Link commits/PRs to Linear issues. Free tier supports up to 2 teams &mdash; pick which one to use.</p>
    <div id="saved-linear" class="saved hide"></div>
    <div id="edit-linear">
      <div class="inwrap"><input id="in-linear" type="password" placeholder="lin_api_..." autocomplete="off" /><button type="button" class="eye" onclick="toggleEye('in-linear', this)">show</button></div>
    </div>
    <div id="team-linear" class="field hide" style="margin-top:10px"><label for="in-linear-team">Team</label><select id="in-linear-team" onchange="saveLinearTeam()"></select></div>
    <div class="irow">
      <button class="btn-primary2" onclick="testSave('linear')">Test &amp; Save</button>
      <button id="rep-linear" class="btn-line hide" onclick="replaceKey('linear')">Replace</button>
      <button id="dis-linear" class="btn-danger hide" onclick="disconnect('linear')">Disconnect</button>
    </div>
    <div id="err-linear" class="err"></div>
  </div>

  <!-- Render -->
  <div class="intg">
    <div class="ihead"><span class="iname">Render</span><span class="opt">optional</span><span id="b-render" class="badge b-off" style="margin-left:auto">Not connected</span></div>
    <p class="idesc">Bring your Render key to self-host this launcher and (later) deploy apps OpenCode builds. See the README for one-click self-hosting.</p>
    <div id="saved-render" class="saved hide"></div>
    <div id="edit-render">
      <div class="inwrap"><input id="in-render" type="password" placeholder="rnd_..." autocomplete="off" /><button type="button" class="eye" onclick="toggleEye('in-render', this)">show</button></div>
    </div>
    <div class="irow">
      <button class="btn-primary2" onclick="testSave('render')">Test &amp; Save</button>
      <button id="rep-render" class="btn-line hide" onclick="replaceKey('render')">Replace</button>
      <button id="dis-render" class="btn-danger hide" onclick="disconnect('render')">Disconnect</button>
    </div>
    <div id="err-render" class="err"></div>
  </div>
</div>
</body>
</html>`
