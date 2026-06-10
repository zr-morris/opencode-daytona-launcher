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
- `GET /api/sandboxes` — list sandboxes launched by this instance

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
