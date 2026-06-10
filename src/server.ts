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
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'node:20-slim'

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

    const envVar = injectEnvVar('OPENCODE_CONFIG_CONTENT', configJson)
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

// --- List tracked sandboxes ---
app.get('/api/sandboxes', (_req: Request, res: Response) => {
  const out: any[] = []
  sandboxes.forEach((v, k) => out.push({ sandboxId: k, ...v }))
  res.json({ count: out.length, sandboxes: out })
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
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0d10; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { max-width: 640px; padding: 32px; border: 1px solid #222; border-radius: 12px; background: #111418; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { color: #aaa; line-height: 1.5; }
  button { background: #3ddc84; color: #002; border: 0; padding: 12px 20px; font-size: 15px; border-radius: 8px; cursor: pointer; font-weight: 700; }
  button[disabled] { opacity: 0.6; cursor: wait; }
  #out { margin-top: 20px; padding: 14px; background: #0d1115; border: 1px solid #222; border-radius: 8px; white-space: pre-wrap; word-break: break-all; display: none; }
  a { color: #3ddc84; }
</style>
</head>
<body>
<div class="card">
  <h1>OpenCode on Daytona</h1>
  <p>This backend launches the <strong>OpenCode</strong> AI coding agent inside an on-demand <strong>Daytona</strong> sandbox and gives you a preview link to the OpenCode Web interface.</p>
  <button id="go" onclick="launch()">Launch OpenCode Web</button>
  <div id="out"></div>
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
    var tokenLine = d.token ? ('<br><br>Preview token (if prompted):<br><code>' + d.token + '</code>') : ''
    out.innerHTML = 'OpenCode Web is ready!<br><br><a href="' + d.url + '" target="_blank" rel="noopener">' + d.url + '</a>' + tokenLine
    btn.textContent = 'Launch another'
  } catch (e) {
    out.textContent = 'Error: ' + (e.message || e)
    btn.textContent = 'Try again'
  } finally {
    btn.disabled = false
  }
}
</script>
</div>
</body>
</html>`
