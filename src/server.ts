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

import express, { NextFunction, Request, Response } from 'express'
import { Daytona, Sandbox } from '@daytona/sdk'
import crypto from 'node:crypto'

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
// Optional GitHub OAuth login gate.
//
// When GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET are set, the whole app (page +
// every /api route) requires a GitHub login. The login also auto-provisions the
// user's GitHub integration: the OAuth access token (repo scope) is kept in the
// signed session and injected into sandboxes, so no separate PAT is needed.
//
// When those env vars are absent, login is DISABLED and the app behaves exactly
// as the open BYOK version (good for local dev / trusted networks).
//
// Sessions are stateless: a signed (HMAC-SHA256) httpOnly cookie carrying the
// GitHub login + token + expiry. No session store needed (free-tier friendly).
// ---------------------------------------------------------------------------
const GH_CLIENT_ID = process.env.GITHUB_CLIENT_ID || ''
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || ''
const AUTH_ENABLED = Boolean(GH_CLIENT_ID && GH_CLIENT_SECRET)
// Cookie signing secret. Falls back to a random per-boot secret (sessions reset
// on restart) so it works even if the operator forgets to set SESSION_SECRET.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const SESSION_COOKIE = 'ocdl_session'
const OAUTH_STATE_COOKIE = 'ocdl_oauth_state'
// Allowlist: only these GitHub usernames and/or members of this org may log in.
const ALLOWED_USERS = (process.env.ALLOWED_GITHUB_USERS || '')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
const ALLOWED_ORG = (process.env.ALLOWED_GITHUB_ORG || '').trim()

interface Session { login: string; name?: string; avatar?: string; ghToken: string; exp: number }

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(str: string): Buffer {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}
function signSession(sess: Session): string {
  const payload = b64url(Buffer.from(JSON.stringify(sess)))
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest())
  return payload + '.' + sig
}
function verifySession(token: string): Session | null {
  if (!token || token.indexOf('.') === -1) return null
  const [payload, sig] = token.split('.')
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest())
  // constant-time compare
  const a = Buffer.from(sig || ''); const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const sess = JSON.parse(b64urlDecode(payload).toString()) as Session
    if (!sess.exp || sess.exp < Date.now()) return null
    return sess
  } catch { return null }
}
function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = req.headers.cookie
  if (!raw) return out
  raw.split(';').forEach((p) => {
    const idx = p.indexOf('=')
    if (idx > -1) out[p.slice(0, idx).trim()] = decodeURIComponent(p.slice(idx + 1).trim())
  })
  return out
}
function getSession(req: Request): Session | null {
  if (!AUTH_ENABLED) return null
  return verifySession(parseCookies(req)[SESSION_COOKIE] || '')
}
function setSessionCookie(res: Response, token: string) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
}
function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`)
}

// Verify a logged-in GitHub user is allowed (username allowlist OR org membership).
// If no allowlist is configured, ANY GitHub user is allowed (warned in UI/docs).
async function isUserAllowed(login: string, token: string): Promise<boolean> {
  if (!ALLOWED_USERS.length && !ALLOWED_ORG) return true
  if (ALLOWED_USERS.includes(login.toLowerCase())) return true
  if (ALLOWED_ORG) {
    try {
      const r = await fetch(`https://api.github.com/orgs/${ALLOWED_ORG}/members/${login}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'opencode-daytona-launcher', Accept: 'application/vnd.github+json' },
      })
      // 204 = is a member; 302/404 = not a member / not visible
      if (r.status === 204) return true
    } catch {}
  }
  return false
}

// Middleware: require a valid session for protected routes when AUTH is enabled.
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_ENABLED) return next()
  const sess = getSession(req)
  if (sess) { (req as any).session = sess; return next() }
  // API routes get JSON 401; page routes redirect to /login.
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required', loginRequired: true })
  return res.redirect('/login')
}

// Compute this deployment's external base URL (honors proxy headers on Render).
function baseUrl(req: Request): string {
  const envBase = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '')
  if (envBase) return envBase
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https'
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host
  return `${proto}://${host}`
}

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

// ---- Favicon: inline SVG (terminal prompt mark, app dark + green theme) ----
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#11161c"/>
      <stop offset="1" stop-color="#0a0d10"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="1.4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#bg)" stroke="#1f2730" stroke-width="2"/>
  <g filter="url(#glow)" fill="none" stroke="#3ddc84" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20,22 30,32 20,42"/>
    <line x1="36" y1="42" x2="46" y2="42"/>
  </g>
</svg>`

app.get('/favicon.svg', (_req: Request, res: Response) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(FAVICON_SVG)
})
// Some browsers request /favicon.ico directly; point them at the SVG.
app.get('/favicon.ico', (_req: Request, res: Response) => res.redirect(301, '/favicon.svg'))

// ---- Auth status endpoint (always available; tells the UI whether to show login) ----
app.get('/api/me', (req: Request, res: Response) => {
  if (!AUTH_ENABLED) return res.json({ authEnabled: false, authed: true })
  const sess = getSession(req)
  if (!sess) return res.json({ authEnabled: true, authed: false })
  return res.json({
    authEnabled: true, authed: true,
    login: sess.login, name: sess.name, avatar: sess.avatar,
    // Tells the UI that GitHub is auto-connected via login (hide the PAT card).
    githubAuto: true,
  })
})

// ---- GitHub OAuth: login page ----
app.get('/login', (req: Request, res: Response) => {
  if (!AUTH_ENABLED) return res.redirect('/')
  if (getSession(req)) return res.redirect('/')
  const err = typeof req.query.error === 'string' ? req.query.error : ''
  res.type('html').send(loginPage(err))
})

// ---- GitHub OAuth: start (redirect to GitHub consent) ----
app.get('/auth/github', (req: Request, res: Response) => {
  if (!AUTH_ENABLED) return res.redirect('/')
  const state = b64url(crypto.randomBytes(16))
  // store state in a short-lived cookie to defend against CSRF
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`)
  const redirectUri = `${baseUrl(req)}/auth/github/callback`
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', GH_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', 'read:user repo') // repo => login token can push code
  url.searchParams.set('state', state)
  url.searchParams.set('allow_signup', 'false')
  res.redirect(url.toString())
})

// ---- GitHub OAuth: callback ----
app.get('/auth/github/callback', async (req: Request, res: Response) => {
  if (!AUTH_ENABLED) return res.redirect('/')
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const cookieState = parseCookies(req)[OAUTH_STATE_COOKIE] || ''
  if (!code || !state || state !== cookieState) {
    return res.redirect('/login?error=' + encodeURIComponent('Login failed (bad state). Please try again.'))
  }
  try {
    const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GH_CLIENT_ID,
        client_secret: GH_CLIENT_SECRET,
        code,
        redirect_uri: `${baseUrl(req)}/auth/github/callback`,
      }),
    })
    const tok: any = await tokenResp.json()
    const ghToken = tok.access_token
    if (!ghToken) return res.redirect('/login?error=' + encodeURIComponent('GitHub did not return a token.'))
    // fetch the user
    const uResp = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${ghToken}`, 'User-Agent': 'opencode-daytona-launcher', Accept: 'application/vnd.github+json' },
    })
    if (!uResp.ok) return res.redirect('/login?error=' + encodeURIComponent('Could not read your GitHub profile.'))
    const u: any = await uResp.json()
    const login = String(u.login || '')
    const allowed = await isUserAllowed(login, ghToken)
    if (!allowed) {
      return res.redirect('/login?error=' + encodeURIComponent('@' + login + ' is not authorized to use this instance.'))
    }
    const sess: Session = { login, name: u.name || undefined, avatar: u.avatar_url || undefined, ghToken, exp: Date.now() + SESSION_TTL_MS }
    setSessionCookie(res, signSession(sess))
    // clear the state cookie
    res.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`)
    console.log('[auth] login ok: @%s', login)
    return res.redirect('/')
  } catch (err: any) {
    return res.redirect('/login?error=' + encodeURIComponent('Login error: ' + String(err?.message || err)))
  }
})

// ---- Logout ----
app.post('/auth/logout', (_req: Request, res: Response) => { clearSessionCookie(res); res.json({ ok: true }) })
app.get('/auth/logout', (_req: Request, res: Response) => { clearSessionCookie(res); res.redirect('/login') })


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
app.get('/', requireAuth, (_req: Request, res: Response) => {
  res.type('html').send(LANDING_HTML)
})

// --- Launch a new OpenCode Web sandbox ---
app.post('/api/launch', requireAuth, async (req: Request, res: Response) => {
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
    // GitHub: prefer the logged-in user's OAuth token (auto-provisioned via the
    // GitHub login gate) so no separate PAT is needed; fall back to a header/env.
    //
    // IMPORTANT: do NOT export the GitHub token as GITHUB_TOKEN / GH_TOKEN env
    // vars. OpenCode auto-activates its "GitHub Copilot" and "GitHub Models"
    // providers whenever GITHUB_TOKEN is present, which adds a duplicate, broken
    // gpt-5.5 (and other models) routed through Copilot — failing with "socket
    // connection closed" because a normal OAuth/PAT token has no Copilot access.
    // Git clone/push still works via the ~/.git-credentials helper set up below,
    // which does not need these env vars. So we only use the token for git creds.
    const sessForLaunch = getSession(req)
    const ghForSandbox = (sessForLaunch && sessForLaunch.ghToken) || creds.githubToken
    // GH_TOKEN is safe: the gh CLI + GitHub-aware tooling read it, but OpenCode
    // does NOT enable its (broken-for-us) Copilot/Models providers from it —
    // only GITHUB_TOKEN does that. So we wire GitHub without breaking gpt-5.5.
    if (ghForSandbox) envVars.GH_TOKEN = ghForSandbox
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
      ghForSandbox ? 'GitHub is wired: git is configured with credentials and the gh CLI is authenticated for the user. You can git clone/commit/push over HTTPS and use gh (e.g. gh repo create, gh pr create, gh issue list, gh api) without asking for a token.' : '',
      creds.linearKey ? 'Linear is available: the LINEAR_API_KEY environment variable is set' + (creds.linearTeam ? ' and LINEAR_TEAM_ID identifies the chosen team' : '') + '. You can call the Linear GraphQL API at https://api.linear.app/graphql using Authorization: $LINEAR_API_KEY (no Bearer prefix) to read/create issues.' : '',
    ].filter(Boolean).join(' ')

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
    if (ghForSandbox) {
      const ghLine = `https://x-access-token:${ghForSandbox}@github.com`
      const ghB64 = Buffer.from(ghLine + '\n').toString('base64')
      const ghTokB64 = Buffer.from(ghForSandbox).toString('base64')
      try {
        await sandbox.process.executeCommand(
          // git credential helper (clone/push over https)
          `git config --global credential.helper store; ` +
            `umask 077; echo '${ghB64}' | base64 -d > "$HOME/.git-credentials"; ` +
            `chmod 600 "$HOME/.git-credentials"; ` +
            `git config --global user.name "OpenCode"; ` +
            // install the gh CLI (fast on node:20 / Debian) if missing
            `if ! command -v gh >/dev/null 2>&1; then ` +
            `  (type -p curl >/dev/null || apt-get install -y -qq curl) >/dev/null 2>&1; ` +
            `  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg 2>/dev/null | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null; ` +
            `  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null; ` +
            `  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; ` +
            `  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq gh >/dev/null 2>&1; ` +
            `fi; ` +
            // authenticate gh with the token (via stdin, never on the command line)
            `echo '${ghTokB64}' | base64 -d | gh auth login --with-token >/dev/null 2>&1 || true; ` +
            `gh auth setup-git >/dev/null 2>&1 || true; ` +
            `true`,
          undefined,
          undefined,
          180,
        )
        console.log('[launch] GitHub wired: git creds + gh CLI authenticated (%s)', last4(ghForSandbox))
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
app.post('/api/stop', requireAuth, async (req: Request, res: Response) => {
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

// --- Status of a single sandbox (used to poll until a Stop actually completes) ---
// Returns { exists, gone, state }. 'gone' is true when the sandbox no longer
// exists or is in a terminal/destroying state, i.e. safe to remove from the UI.
app.get('/api/sandbox-status', requireAuth, async (req: Request, res: Response) => {
  const conn = daytonaFromReq(req)
  if (!conn) return res.status(400).json({ error: NO_KEY_MSG })
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id is required' })
  const GONE_STATES = new Set(['destroying', 'destroyed', 'archived', 'archiving', 'error', 'stopped'])
  try {
    const sb = await (conn.daytona as any).get(id)
    if (!sb) return res.json({ exists: false, gone: true, state: 'deleted' })
    const state = String((sb as any).state ?? 'unknown')
    return res.json({ exists: true, gone: GONE_STATES.has(state), state })
  } catch (err: any) {
    // get() throwing (e.g. 404) means the sandbox is gone.
    return res.json({ exists: false, gone: true, state: 'deleted' })
  }
})

// --- Bulk-stop launcher sandboxes that have been idle past a threshold ---
// Idle = running AND lastActivityAt older than idleMinutes (default 30).
// Only ever touches sandboxes labeled app=opencode-launcher.
app.post('/api/stop-idle', requireAuth, async (req: Request, res: Response) => {
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
app.get('/api/sandboxes', requireAuth, async (req: Request, res: Response) => {
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
        ready: false,
      })
    }
    // Probe each running sandbox's public preview URL in parallel (short timeout)
    // so the list only marks a link 'ready' once it actually answers — matching
    // the launch readiness check and preventing a premature (502-prone) link.
    await Promise.all(out.map(async (row) => {
      if (!row.url || !row.running) return
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), 3500)
        const r = await fetch(row.url, { method: 'GET', redirect: 'manual', signal: ctl.signal })
        clearTimeout(t)
        if (r.status === 200 || (r.status >= 300 && r.status < 400)) row.ready = true
      } catch { /* not ready yet */ }
    }))
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
app.get('/api/usage', requireAuth, async (req: Request, res: Response) => {
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
app.post('/api/validate/daytona', requireAuth, async (req: Request, res: Response) => {
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
app.post('/api/validate/github', requireAuth, async (req: Request, res: Response) => {
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
app.post('/api/validate/linear', requireAuth, async (req: Request, res: Response) => {
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
app.post('/api/validate/render', requireAuth, async (req: Request, res: Response) => {
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

const noAllowlistWarning = (!ALLOWED_USERS.length && !ALLOWED_ORG)
  ? '<div class="warn">No allowlist is configured, so any GitHub user can sign in. Set ALLOWED_GITHUB_USERS and/or ALLOWED_GITHUB_ORG to restrict access.</div>'
  : ''

function loginPage(error: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in &middot; OpenCode on Daytona</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0d10; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 20px; }
  .card { width: 100%; max-width: 420px; padding: 36px 32px; border: 1px solid #222; border-radius: 12px; background: #111418; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #9aa; font-size: 13px; line-height: 1.55; margin: 0 0 24px; }
  .gh { display: inline-flex; align-items: center; gap: 10px; background: #fff; color: #111; border: 0; padding: 12px 20px; font-size: 15px; font-weight: 700; border-radius: 8px; cursor: pointer; font-family: inherit; text-decoration: none; }
  .gh:hover { background: #e9e9e9; }
  .gh svg { width: 18px; height: 18px; }
  .err { color: #ff6b6b; font-size: 13px; margin-bottom: 18px; min-height: 16px; }
  .warn { color: #ffc857; font-size: 11px; line-height: 1.5; margin-top: 20px; border: 1px solid #4a3a1f; background: #1c160c; border-radius: 8px; padding: 10px 12px; }
  .foot { color: #5a6672; font-size: 11px; margin-top: 22px; }
</style></head>
<body>
<div class="card">
  <h1>OpenCode on Daytona</h1>
  <p>Sign in with GitHub to continue. Your GitHub account is also used to let OpenCode push code on your behalf &mdash; no separate token needed.</p>
  <div class="err">${error ? error.replace(/</g, '&lt;') : ''}</div>
  <a class="gh" href="/auth/github">
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
    Sign in with GitHub
  </a>
  ${noAllowlistWarning}
  <div class="foot">This instance is access-gated. Only authorized GitHub users can enter.</div>
</div>
</body></html>`
}

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenCode on Daytona</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
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
    <div style="display:flex;align-items:center;gap:10px">
      <span id="whoami" class="muted" style="display:none;font-size:12px"></span>
      <button id="logoutBtn" class="gear" style="display:none" onclick="logout()">Log out</button>
      <button class="gear" onclick="openDrawer()">&#9881; Settings</button>
    </div>
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

// ---- account / login state ----
var ACCOUNT = { authEnabled: false, authed: true, githubAuto: false }
async function loadAccount() {
  try { var r = await fetch('/api/me'); ACCOUNT = await r.json() }
  catch (e) { ACCOUNT = { authEnabled: false, authed: true } }
  if (ACCOUNT.authEnabled && ACCOUNT.authed && ACCOUNT.login) {
    var who = document.getElementById('whoami')
    if (who) { who.textContent = '@' + ACCOUNT.login; who.style.display = '' }
    var lo = document.getElementById('logoutBtn'); if (lo) lo.style.display = ''
  }
  if (ACCOUNT.githubAuto) {
    // GitHub is auto-connected by the login — hide the PAT card, show green.
    var card = document.getElementById('card-github'); if (card) card.classList.add('hide')
    setChip('github', true)
    setBadge('github', 'on', 'Connected via login')
    // If a stale PAT was saved before login was enabled, clear it to avoid confusion.
    if (lsGet(LS.githubToken)) lsSet(LS.githubToken, '')
  }
}
async function logout() {
  try { await fetch('/auth/logout', { method: 'POST' }) } catch (e) {}
  location.href = '/login'
}

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
    // GitHub auto-provisioned by the login gate: mark connected-via-login and
    // skip the PAT path entirely (the card is hidden in loadAccount).
    if (p === 'github' && ACCOUNT.githubAuto) {
      setBadge('github', 'on', 'Connected via login')
      setChip('github', true)
      continue
    }
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
  loadAccount().then(function () { hydrateDrawer() })
  refreshAll()
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
    out.setAttribute('data-sandbox', d.sandboxId || '')
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

// Sandboxes the user just stopped. Daytona's list() is eventually consistent
// and may keep returning a just-deleted sandbox as 'started' for a few seconds,
// which would make the row reappear. We suppress these ids client-side until
// Daytona stops returning them.
var STOPPED_IDS = {}
function markStopped(id) { STOPPED_IDS[id] = Date.now() }
async function refresh() {
  // Don't fight an in-progress Stop: re-rendering would reset the 'Stopping...'
  // button. Skip this refresh cycle while any stop is mid-flight.
  if (Object.keys(STOPPING).length) return
  const list = document.getElementById('list')
  const status = document.getElementById('listStatus')
  status.textContent = 'loading...'
  try {
    const r = await fetch('/api/sandboxes', { headers: authHeaders() })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Failed to list')
    var rawItems = d.sandboxes || []
    // Drop any ids the server still returns but the user just stopped.
    var returnedIds = {}
    rawItems.forEach(function (x) { returnedIds[x.sandboxId] = true })
    const items = rawItems.filter(function (x) { return !STOPPED_IDS[x.sandboxId] })
    // Forget suppression once Daytona stops returning that id (and after >2min safety).
    Object.keys(STOPPED_IDS).forEach(function (id) {
      if (!returnedIds[id] || (Date.now() - STOPPED_IDS[id]) > 120000) delete STOPPED_IDS[id]
    })
    status.textContent = items.length + ' sandbox' + (items.length === 1 ? '' : 'es')
    if (!items.length) {
      list.innerHTML = '<p class="muted">No active sandboxes.</p>'
      return
    }
    list.innerHTML = items.map(function (s) {
      var urlBlock
      var copyBtn
      if (s.url && s.ready) {
        urlBlock = '<a class="url" href="' + s.url + '" target="_blank" rel="noopener">' + s.url + '</a>'
        copyBtn = '<button class="btn-sm btn-copy" onclick="copyUrl(this, \\'' + s.url + '\\')">Copy link</button>'
      } else if (s.url) {
        // Sandbox exists but OpenCode Web is not serving yet — avoid a 502-prone link.
        urlBlock = '<div class="sub" style="color:#9a9a9a">\\u23f3 Starting OpenCode Web\\u2026 link appears when ready</div>'
        copyBtn = '<button class="btn-sm btn-copy" disabled style="opacity:.5;cursor:default">Copy link</button>'
      } else {
        urlBlock = '<div class="sub" style="color:#9a9a9a">\\u23f3 Starting\\u2026</div>'
        copyBtn = ''
      }
      var dotClass = (s.running && s.ready) ? 'run' : (s.running ? 'other' : (String(s.state) === 'stopped' ? 'stop' : 'other'))
      var statePill = (s.running && !s.ready) ? 'starting' : (s.state || '')
      var resChips = '<span class="res">' +
        '<span>' + (s.cpu || 0) + ' vCPU</span>' +
        '<span>' + (s.memory || 0) + ' GiB</span>' +
        '<span>' + (s.disk || 0) + ' GiB disk</span>' +
        '</span>'
      return '<div class="row" data-sandbox="' + s.sandboxId + '">' +
        '<div class="meta">' +
          '<div class="id"><span class="dot ' + dotClass + '"></span>' + short(s.sandboxId) + ' <span class="pill">' + statePill + '</span> <span class="sub" style="margin-left:6px">' + age(s.createdAt) + '</span></div>' +
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

// Ids currently being stopped — pause auto-refresh interference for these so a
// mid-flight list render doesn't reset the 'Stopping...' button.
var STOPPING = {}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
// Clear the 'OpenCode Web is ready!' box if it's showing the given sandbox.
function clearReadyBoxIf(id) {
  var out = document.getElementById('out')
  if (!out) return
  if (out.getAttribute('data-sandbox') === id) {
    out.style.display = 'none'
    out.innerHTML = ''
    out.removeAttribute('data-sandbox')
  }
}

async function stop(id, btn) {
  if (!confirm('Stop and delete sandbox ' + short(id) + '? This cannot be undone.')) return
  btn.disabled = true
  btn.textContent = 'Stopping...'
  STOPPING[id] = true
  markStopped(id)
  try {
    const r = await fetch('/api/stop', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sandboxId: id }) })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Stop failed')

    // Poll Daytona until the sandbox is actually gone, keeping the button in the
    // 'Stopping...' state the whole time. Only then remove the row.
    var gone = false
    for (var i = 0; i < 45; i++) { // up to ~90s
      await sleep(2000)
      try {
        var sr = await fetch('/api/sandbox-status?id=' + encodeURIComponent(id), { headers: authHeaders() })
        var sd = await sr.json()
        if (sr.ok && sd.gone) { gone = true; break }
      } catch (e) { /* keep polling */ }
    }

    // Remove the row (whether confirmed gone or we hit the poll cap — it's
    // deleting regardless).
    var row = document.querySelector('.row[data-sandbox="' + id + '"]')
    if (row && row.parentNode) row.parentNode.removeChild(row)
    clearReadyBoxIf(id)
    var listEl = document.getElementById('list')
    var statusEl = document.getElementById('listStatus')
    var remaining = listEl ? listEl.querySelectorAll('.row').length : 0
    if (statusEl) statusEl.textContent = remaining + ' sandbox' + (remaining === 1 ? '' : 'es')
    if (listEl && remaining === 0) listEl.innerHTML = '<p class="muted">No active sandboxes.</p>'
    delete STOPPING[id]
    refreshAll()
  } catch (e) {
    delete STOPPING[id]
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
    ;(d.stopped || []).forEach(function (sid) {
      markStopped(sid)
      var rr = document.querySelector('.row[data-sandbox="' + sid + '"]')
      if (rr && rr.parentNode) rr.parentNode.removeChild(rr)
      clearReadyBoxIf(sid)
    })
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
  <div class="intg" id="card-github">
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
