# OpenCode + Daytona Launcher (Render backend)

A small Express backend that launches the [OpenCode](https://opencode.ai/) AI
coding agent inside **on-demand Daytona sandboxes**, following the official
guide: <https://www.daytona.io/docs/en/guides/opencode/opencode-web-agent/>

Deployed on Render's free tier. When a user clicks **Launch**, the backend:

1. Creates a fresh Daytona sandbox (via `@daytona/sdk`).
2. Installs `opencode-ai` inside it.
3. Configures the Daytona-aware `daytona` agent (file ops in `/home/daytona`,
   preview-link instructions).
4. Starts `opencode web` on port 3000 in the sandbox.
5. Returns the Daytona **preview link** (and access token) to the OpenCode Web UI.

## Endpoints

- `GET /` — landing page with a Launch button
- `GET /healthz` — health check (used by Render)
- `POST /api/launch` — create a sandbox + start OpenCode; returns `{ url, token, sandboxId }`
- `POST /api/stop` — body `{ "sandboxId": "..." }` deletes a sandbox
- `GET /api/sandboxes` — list **live** sandboxes created by this launcher (queried from Daytona, scoped by the `app=opencode-launcher` label; terminal/destroying states hidden)

## Managing sandboxes

The landing page shows an **Active sandboxes** section listing every sandbox
this launcher created (label-scoped). Each row has an **open** link and a
**Stop** button that deletes the sandbox via `POST /api/stop`. Use **Refresh**
to re-query Daytona. Stopping a sandbox frees Daytona free-tier resources.

## Environment variables (set in Render dashboard)

- `DAYTONA_API_KEY` (required) — used to create sandboxes
- `OPENAI_API_KEY` (optional) — persisted into each sandbox so OpenCode can use OpenAI without prompting
- `PORT` — injected automatically by Render

## Local development

```bash
cp .env.example .env   # set DAYTONA_API_KEY
npm install
npm run dev            # builds + runs on PORT (default 3000)
```

## Notes on Render free tier

- Free web services spin down after ~15 min of inactivity; the first request
  after idle takes a few seconds to wake. This is fine here because the backend
  is just an orchestrator — the heavy OpenCode workload runs in **Daytona**, not
  on Render.
- Each launched sandbox consumes Daytona resources; use `POST /api/stop` (or the
  Daytona dashboard) to clean up when finished.

## Default model

The launched OpenCode instances default to **DeepSeek V4 Flash Free**
(`opencode/deepseek-v4-flash-free`), served through OpenCode's free gateway —
no API key required. This is set via the injected OpenCode config (top-level
`model` plus the `daytona` agent's `model`). Users can switch models in the
OpenCode Web UI at any time.

## Daytona free-tier note (sandbox class)

Daytona's default snapshot uses the `linux-vm` class, which free-tier orgs
cannot run in the `us` region (`Region us is not available to the organization
for class linux-vm`). To stay on the free tier, this backend creates sandboxes
**from an image** (`node:20-slim` by default), which runs as the `container`
class. Override with env vars if needed:

- `SANDBOX_IMAGE` (default `node:20-slim`)
- `DAYTONA_TARGET` (default `us`)
