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

const daytonaApiKey = process.env.DAYTONA_API_KEY
if (!daytonaApiKey) {
  console.error('FATAL: DAYTONA_API_KEY is not set. Set it in the Render service environment.')
}

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
    daytonaConfigured: Boolean(daytonaApiKey),
    opencodeVersion: OPENCODE_VERSION,
    defaultModel: DEFAULT_MODEL,
    sandboxImage: SANDBOX_IMAGE,
    daytonaTarget: DAYTONA_TARGET,
    activeSandboxes: sandboxes.size,
  })
})

// --- Landing page ---
app.get('/', (_req: Request, res: Response) => {
  res.type('html').send(LANDING_HTML)
})

// --- Launch a new OpenCode Web sandbox ---
app.post('/api/launch', async (_req: Request, res: Response) => {
  if (!daytonaApiKey) {
    return res.status(500).json({ error: 'DAYTONA_API_KEY is not configured on the server.' })
  }

  const daytona = new Daytona({ apiKey: daytonaApiKey, target: DAYTONA_TARGET })
  let sandbox: Sandbox | undefined

  try {
    console.log('[launch] Creating sandbox...')
    const envVars: Record<string, string> = {}
    if (process.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY
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
    const record = { url: opencodePreviewLink.url, createdAt: new Date().toISOString() }
    sandboxes.set(sandboxId, record)

    const previewToken = (opencodePreviewLink as any).token as string | undefined
    console.log(`[launch] Ready: ${opencodePreviewLink.url} (sandbox=${sandboxId})`)
    return res.json({
      ok: true,
      sandboxId,
      url: opencodePreviewLink.url,
      token: previewToken,
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
  if (!daytonaApiKey) return res.status(500).json({ error: 'DAYTONA_API_KEY not configured' })
  const sandboxId = (req.body && req.body.sandboxId) as string | undefined
  if (!sandboxId) return res.status(400).json({ error: 'sandboxId is required' })
  try {
    const daytona = new Daytona({ apiKey: daytonaApiKey, target: DAYTONA_TARGET })
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
  if (!daytonaApiKey) return res.status(500).json({ error: 'DAYTONA_API_KEY not configured' })
  const idleMinutes = Math.max(
    1,
    parseInt(String((req.body && req.body.idleMinutes) ?? DEFAULT_IDLE_MINUTES), 10) || DEFAULT_IDLE_MINUTES,
  )
  const cutoff = Date.now() - idleMinutes * 60_000
  const TERMINAL = new Set(['destroying', 'destroyed', 'archived', 'archiving', 'error'])
  try {
    const daytona = new Daytona({ apiKey: daytonaApiKey, target: DAYTONA_TARGET })
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
app.get('/api/sandboxes', async (_req: Request, res: Response) => {
  if (!daytonaApiKey) return res.status(500).json({ error: 'DAYTONA_API_KEY not configured' })
  try {
    const daytona = new Daytona({ apiKey: daytonaApiKey, target: DAYTONA_TARGET })
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
app.get('/api/usage', async (_req: Request, res: Response) => {
  if (!daytonaApiKey) return res.status(500).json({ error: 'DAYTONA_API_KEY not configured' })
  try {
    const daytona = new Daytona({ apiKey: daytonaApiKey, target: DAYTONA_TARGET })
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`opencode-daytona-launcher listening on 0.0.0.0:${PORT}`)
  console.log(`Daytona configured: ${Boolean(daytonaApiKey)}`)
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
</style>
</head>
<body>
<div class="card">
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
async function launch() {
  const btn = document.getElementById('go')
  const out = document.getElementById('out')
  btn.disabled = true
  btn.textContent = 'Launching sandbox... (~30-60s)'
  out.style.display = 'block'
  out.textContent = 'Creating Daytona sandbox, installing OpenCode, starting web server...'
  try {
    const r = await fetch('/api/launch', { method: 'POST' })
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
    const r = await fetch('/api/usage')
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
    const r = await fetch('/api/sandboxes')
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
    const r = await fetch('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sandboxId: id }) })
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
    var r = await fetch('/api/stop-idle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idleMinutes: IDLE_MINUTES }) })
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

refreshAll()
// Auto-refresh the dashboard + list every 15s.
setInterval(refreshAll, 15000)
</script>
</div>
</body>
</html>`
