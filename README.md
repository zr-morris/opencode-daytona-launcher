# OpenCode on Daytona — Launcher

Launch the [OpenCode](https://opencode.ai/) AI coding agent inside **on-demand
[Daytona](https://www.daytona.io/) sandboxes**, straight from your browser. Click
**Launch**, get a private OpenCode Web URL in ~30–60s, and start coding. Run
several at once, watch your free-tier quota live, and clean up with one click.

This is a small, **stateless, bring-your-own-keys (BYOK)** Express app designed to
be trivially self-hosted on Render's free tier. You enter your own API keys in the
UI; the server never stores them.

> **Deploy your own copy in one command.** Clone or fork, then run `npm run setup`
> — it provisions a Render service in _your own_ Render account and deploys this
> launcher for you. See [Deploy in one command](#deploy-in-one-command-recommended) below.

---

## Features

- **One-click OpenCode sandboxes** — provisions a Daytona sandbox, installs
  OpenCode, and starts OpenCode Web, returning a ready-to-use preview URL.
- **Reliable links** — a two-stage readiness check (server bound *and* the public
  proxy route live) means the URL works the moment you receive it (no 502s).
- **Run many at once** — every sandbox gets its own preview URL; copy any link to
  open it on your phone or share it.
- **Live free-tier dashboard** — gauges for vCPU / memory / disk against your
  Daytona quota, a "slots remaining" headline, and per-sandbox resource chips.
- **Cleanup controls** — **Stop** any sandbox, or **Stop all idle** to reclaim
  quota from abandoned ones in one click.
- **BYOK integrations** — connect **GitHub** (clone/push/PR), **Linear** (issue
  linking, with team selection), and **Render**, each validated live in a Settings
  drawer. The integration keys are injected into your sandboxes so OpenCode can use
  them.

> LLM connectivity is handled **natively by OpenCode** inside the sandbox — there's
> no LLM key to configure here. The default model is OpenCode's free DeepSeek V4
> Flash; switch models inside OpenCode as you like.

---

## How it works

```
Browser (your keys in localStorage)
   │  X-Daytona-Key / X-GitHub-Token / X-Linear-Key / X-Render-Key  (per request)
   ▼
Launcher (this app, stateless — never stores keys)
   │  @daytona/sdk
   ▼
Daytona sandbox  →  installs OpenCode  →  `opencode web`  →  public preview URL
```

- **Stateless server.** Keys are sent with each request as `X-*` headers and used
  only for that request. Nothing is persisted server-side.
- **Keys live in your browser.** They're stored in `localStorage` and sent
  directly to your own Daytona / GitHub / Linear / Render.
- **Daytona as the gate.** The app is locked until you provide a valid Daytona key.

---

## Deploy in one command (recommended)

The fastest way to self-host: clone (or fork), then run the setup CLI, which
**programmatically creates a Render web service in your own Render account** and
deploys this launcher — no dashboard clicking required.

```bash
git clone https://github.com/YOUR-USERNAME/opencode-daytona-launcher.git
cd opencode-daytona-launcher
npm install
npm run setup
```

`npm run setup` will:
- Auto-detect your repo URL from git (confirm or override). **The repo must be
  public** — Render's API can only auto-create a service from a public repo URL
  without a browser GitHub connection.
- Prompt for your **Render API key** (creates the service) and **Daytona key**
  (baked into the deploy, so the web onboarding skips the Daytona step).
- Optionally enable the **GitHub login gate** (Client ID/Secret + allowlist; a
  `SESSION_SECRET` is generated for you).
- Create the service (free plan), set env vars, deploy, wait until it's live, and
  print your URL.

You can also run it non-interactively with env vars:
```bash
RENDER_API_KEY=... DAYTONA_API_KEY=... npm run setup
```

> **Public-repo services don't auto-deploy.** After you push changes to your fork,
> redeploy with:
> ```bash
> npm run deploy
> ```

> Get your keys: **Render** → https://dashboard.render.com/u/settings#api-keys ·
> **Daytona** → https://app.daytona.io (free tier). GitHub login + Linear are set
> up later (see below).

### Alternative: deploy via the Render dashboard (fork first)

> **Important — deploy from _your own_ fork, not someone else's repo.** This app
> is meant to be self-hosted. Always fork it into your own GitHub account and
> connect _your_ fork to _your_ Render account. There is intentionally **no
> "one-click deploy from this repo" button**: a shared deploy link would couple
> your service to a repo you don't control and blur ownership of the instance.

### 1. Fork this repo
Click **Fork** at the top of the GitHub page to copy it into your own account
(e.g. `your-username/opencode-daytona-launcher`).

### 2. Create a Render web service from your fork
In the [Render dashboard](https://dashboard.render.com): **New → Web Service**,
then connect **your fork**. Render will detect [`render.yaml`](./render.yaml) (a
free, zero-env Blueprint). If you create the service manually instead, use:

- **Runtime:** Node
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Health Check Path:** `/healthz`

### 3. Open the URL and add your keys
No environment variables are required. When the service is live, open its URL and
paste your **Daytona** key in the onboarding screen. Add GitHub / Linear / Render
in **Settings** as needed. Your keys live in your browser, not on the server.

> **Heads-up (Render free tier):** free web services sleep after inactivity, so the
> first request after idle takes a few extra seconds to wake.

> **Who can use your instance?** Because keys are entered per-browser (BYOK), the
> _server_ holds no secrets — but anyone who can open your URL can use the app with
> _their own_ keys, and (see [Security model](#security-model)) `localStorage` is
> not isolation between untrusted users. Keep your instance to people you trust, or
> put it behind your own auth/VPN if you expose it more widely.

---

## Getting your API keys

You only need **Daytona** to start. The rest are optional and unlock extra powers.

### Daytona  *(required)*
1. Sign in at **https://app.daytona.io** (free tier available).
2. Create an **API key** in your account settings.
3. Paste it into the launcher's onboarding screen and pick your region (`us`/`eu`).

The free tier ("Tier 1") gives a shared pool of **10 vCPU / 10 GiB RAM / 30 GiB
disk**. Each OpenCode sandbox uses 1 vCPU / 2 GiB / 5 GiB, so you can run a handful
concurrently — the dashboard shows exactly how many "slots" remain.

### GitHub  *(optional)*
1. Create a token at **https://github.com/settings/tokens**.
2. A classic token with the **`repo`** scope (or a fine-grained token with
   repository contents read/write) works well.
3. Add it in **Settings → GitHub**. Once connected, the launcher configures git
   inside each sandbox so OpenCode can clone, commit, push, and open PRs as you.

### Linear  *(optional)*
1. Go to **https://linear.app/settings/api** → **Personal API keys** →
   **Create key**.
2. Add it in **Settings → Linear**. After it validates, pick which **team** to use
   from the dropdown (the free tier supports up to 2 teams).
3. The key and selected team are injected into your sandboxes so OpenCode can link
   work to Linear issues.

### Render  *(optional)*
1. Create a key at **https://dashboard.render.com/u/settings#api-keys**.
2. Add it in **Settings → Render**. It's validated against your Render account and
   injected into sandboxes for self-host automation and future "deploy what
   OpenCode built" features.

---

## Local development

```bash
# Clone your fork (replace YOUR-USERNAME), or the canonical repo to try it out.
git clone https://github.com/YOUR-USERNAME/opencode-daytona-launcher.git
cd opencode-daytona-launcher
npm install
npm run build
npm start
# open http://localhost:3000
```

No `.env` is required — enter your keys in the UI. If you'd rather pre-bake
credentials (e.g. for a shared internal deployment), copy `.env.example` to `.env`
and set any of the optional fallbacks; a request header always overrides the env
value.

---

## Security model

- **Your keys stay in your browser.** They're stored in `localStorage` and sent
  per-request as `X-*` headers directly to your own service accounts.
- **The server is stateless.** It never persists keys to disk or a database, and it
  never logs full key values (only presence/last-4 for diagnostics).
- **Trade-off:** `localStorage` is readable by any JavaScript running on the page,
  so this design assumes a **trusted, self-hosted** deployment for you and your
  team — not an untrusted public multi-tenant SaaS. Don't deploy a shared instance
  and hand the URL to strangers expecting key isolation.
- **Sandbox previews are public.** Launched sandboxes use Daytona public preview
  URLs (so links work on mobile with no login). Treat those URLs as
  unauthenticated; don't put secrets in a sandbox you've shared.

---

## Locking down your instance (GitHub login)

By default the app is **open** — anyone who can reach the URL can use it (with
their own keys). To restrict access, enable the optional **GitHub OAuth login
gate**.

> **Do this in the right order** (the callback URL depends on your live URL):
> 1. **Deploy first** (steps above) and note your service URL,
>    `https://<your-service>.onrender.com`.
> 2. **Create the GitHub OAuth app** using *that* URL for the callback (below).
> 3. **Add the env vars** to your Render service and let it redeploy.
>
> You can't create the OAuth app before deploying, because GitHub needs your
> real callback URL. The app auto-detects its own URL, so you don't need to
> hardcode it (though you may set `APP_BASE_URL` to be explicit). When enabled, visitors must sign in with GitHub before they can load the
app or call any API, and that **same login auto-connects GitHub for OpenCode** —
the user's OAuth token (with `repo` scope) is injected into their sandboxes, so
there's no separate GitHub PAT to enter.

### 1. Create a GitHub OAuth app
Go to **https://github.com/settings/developers → New OAuth App**:
- **Application name:** anything (e.g. "OpenCode Launcher").
- **Homepage URL:** `https://<your-service>.onrender.com`  *(your real Render URL)*
- **Authorization callback URL:** `https://<your-service>.onrender.com/auth/github/callback`

> Replace `<your-service>` with your actual Render service URL from step 1 — do
> **not** use someone else's URL.

Create it, then **Generate a new client secret**. You'll get a **Client ID** and
**Client Secret**.

### 2. Set environment variables on your Render service
| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | yes (to enable login) | OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | yes (to enable login) | OAuth app client secret |
| `ALLOWED_GITHUB_USERS` | recommended | Comma-separated GitHub usernames allowed to sign in |
| `ALLOWED_GITHUB_ORG` | recommended | A GitHub org whose members are allowed to sign in |
| `SESSION_SECRET` | recommended | Long random string; signs session cookies (keeps logins across restarts) |
| `APP_BASE_URL` | optional | Force the callback base URL, e.g. `https://your-service.onrender.com` |

Setting **both** `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` turns login on.
Leaving them unset keeps the app open (handy for local dev).

> **Always set an allowlist when login is enabled.** Without
> `ALLOWED_GITHUB_USERS` / `ALLOWED_GITHUB_ORG`, **any** GitHub user can sign in.
> The login screen shows a warning if no allowlist is configured.

### How login interacts with the integrations
- **GitHub** becomes automatic — the login token is what OpenCode uses to clone/
  push/PR. The GitHub card disappears from Settings when logged in this way.
- **Linear** and **Render** remain bring-your-own-key in Settings (a GitHub login
  can't authenticate other vendors' APIs).
- Sessions are **stateless signed cookies** (HMAC-SHA256, httpOnly, Secure) — no
  database or session store, so it stays free-tier friendly.

> **Note on `repo` scope:** to push code on your behalf, the OAuth consent
> requests the `repo` scope (read/write to your repos). If you prefer tighter,
> per-repo permissions, a GitHub App (fine-grained tokens) is a future upgrade
> path; this version uses an OAuth App for simplicity.

---

## API reference

All sandbox endpoints read credentials from request headers (`X-Daytona-Key`,
`X-Daytona-Target`, `X-GitHub-Token`, `X-Linear-Key`, `X-Linear-Team`,
`X-Render-Key`), falling back to env vars if absent.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | The web app (onboarding gate + dashboard + settings). |
| `GET` | `/healthz` | Health check; reports which env fallbacks are present (booleans). |
| `GET` | `/api/me` | Auth status: whether login is enabled and who is signed in. |
| `GET` | `/login` | Sign-in page (when login is enabled). |
| `GET` | `/auth/github` | Start GitHub OAuth. |
| `GET` | `/auth/github/callback` | OAuth callback; sets the session cookie. |
| `POST`/`GET` | `/auth/logout` | Clear the session. |
| `POST` | `/api/launch` | Create a sandbox, start OpenCode Web; returns `{ url, token, sandboxId, webReady, publicReady }`. Injects GitHub/Linear/Render creds into the sandbox. |
| `POST` | `/api/stop` | Body `{ "sandboxId": "..." }` — delete a sandbox. |
| `POST` | `/api/stop-idle` | Body `{ "idleMinutes": 30 }` — delete launcher sandboxes idle beyond the threshold. |
| `GET` | `/api/sandboxes` | List live launcher sandboxes (label-scoped) with per-sandbox resources. |
| `GET` | `/api/usage` | Account-wide usage vs the free-tier pool + `slotsRemaining`. |
| `POST` | `/api/validate/daytona` | Validate a Daytona key. |
| `POST` | `/api/validate/github` | Validate a GitHub PAT; returns `{ login, name, avatarUrl }`. |
| `POST` | `/api/validate/linear` | Validate a Linear key; returns `{ viewer, teams }`. |
| `POST` | `/api/validate/render` | Validate a Render key; returns `{ owners }`. |

Sandboxes created by this app are tagged with the label `app=opencode-launcher`,
so listing/stopping only ever touches sandboxes it created.

---

## Tech

- Node + Express + TypeScript, single file (`src/server.ts`), vanilla-JS frontend.
- [`@daytona/sdk`](https://www.npmjs.com/package/@daytona/sdk) for sandbox
  lifecycle and preview links.
- Built per the official
  [Daytona OpenCode Web Agent guide](https://www.daytona.io/docs/en/guides/opencode/opencode-web-agent/).

## License

MIT
