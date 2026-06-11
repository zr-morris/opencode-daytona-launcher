# OpenCode on Daytona — Launcher

Launch the [OpenCode](https://opencode.ai/) AI coding agent inside **on-demand
[Daytona](https://www.daytona.io/) sandboxes**, straight from your browser. Click
**Launch**, get a private OpenCode Web URL in ~30–60s, and start coding. Run
several at once, watch your free-tier quota live, and clean up with one click.

This is a small, **stateless, bring-your-own-keys (BYOK)** Express app designed to
be trivially self-hosted on Render's free tier. You enter your own API keys in the
UI; the server never stores them.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/zr-morris/opencode-daytona-launcher)

> **Zero-config deploy:** no environment variables are required. Deploy it, open
> the URL, paste your Daytona key, and go.

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

## Deploy to Render (recommended)

You have two easy paths:

### A) One-click Blueprint
1. Click the **Deploy to Render** button above.
2. Render reads [`render.yaml`](./render.yaml) and creates a free web service.
3. No environment variables are needed — open the service URL when it's live.

### B) Manual web service
1. Fork/clone this repo to your own GitHub.
2. In Render: **New → Web Service**, connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/healthz`
4. Deploy. Open the URL, paste your Daytona key in the onboarding screen.

> **Heads-up (Render free tier):** free web services sleep after inactivity, so the
> first request after idle takes a few extra seconds to wake.

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
git clone https://github.com/zr-morris/opencode-daytona-launcher.git
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

## API reference

All sandbox endpoints read credentials from request headers (`X-Daytona-Key`,
`X-Daytona-Target`, `X-GitHub-Token`, `X-Linear-Key`, `X-Linear-Team`,
`X-Render-Key`), falling back to env vars if absent.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | The web app (onboarding gate + dashboard + settings). |
| `GET` | `/healthz` | Health check; reports which env fallbacks are present (booleans). |
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
