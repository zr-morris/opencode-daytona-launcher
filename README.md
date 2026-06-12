# OpenCode — Azure Foundry Edition (internal)

OpenCode AI coding workspaces, running in **self-hosted Daytona sandboxes**,
defaulted to your firm's **Azure AI Foundry** deployments, and gated by
**corporate Entra SSO**. Designed to run **inside your Azure VNet** so it can
reach a private Foundry endpoint.

> This is the firm-internal `azure-foundry` edition. It removes the public-cloud
> bits of the original (Render deploy, GitHub login, BYOK key entry, usage
> dashboards). Users sign in with their Microsoft account, name a workspace,
> launch it, and open the link — that's it.

---

## What your users see
- Sign in with their **corporate Microsoft account** (Entra SSO).
- **Name a workspace** (e.g. "Q3 tax memo") and click **Launch**.
- Open the workspace link → OpenCode, already defaulted to your Azure Foundry
  model. No keys, no model setup, no configuration.
- A list of their running workspaces with names + links; **Stop** when done.

No usage meters, no limits UI, no key entry — kept deliberately simple.

---

## Architecture (VNet)
```
User (corp network)
  → internal LB / App Gateway
    → Launcher container (Azure Container Apps / AKS)  ── in VNet
       • Entra SSO for app access
       • Managed identity → Entra token for Foundry (no API key)
      → self-hosted Daytona control plane  ── in VNet
        → OpenCode sandbox (egress stays in-VNet)
          → Azure AI Foundry private endpoint  ✔ reachable
```
Everything runs inside (or peered with) the VNet that has the Foundry private
endpoint + private DNS. Nothing calls Foundry over the public internet.

---

## Install (DevOps)

Run the guided setup on a host that can reach your self-hosted Daytona and
(ideally) the Foundry endpoint, so the live tests pass.

```bash
git clone -b azure-foundry https://github.com/zr-morris/opencode-daytona-launcher.git
cd opencode-daytona-launcher
npm install
npm run setup
```

`npm run setup` will prompt for, and **live-test**:
- **Self-hosted Daytona** — API base URL + key (verifies an authenticated call).
- **Azure Foundry** — base endpoint URL, API version (blank for v1 GA),
  deployment name(s) + default, and auth mode (**Entra managed identity** —
  recommended — or API key). It probes the endpoint to confirm a working call
  and which URL shape to use.
- **Corporate Entra SSO** — tenant ID, app (client) ID, client secret, app base
  URL. (Generates a `SESSION_SECRET`.)

It writes:
- **`.env`** — settings + secrets (gitignored; never committed).
- **`opencode.json`** — the Azure Foundry provider + deployments + default model
  (gitignored by default since it references your internal endpoint).

Then:
```bash
npm run build
npm start            # local sanity check
```

### Deploy into the VNet
Build the container and deploy to **Azure Container Apps** or **AKS** with
**internal ingress only**, joined to the VNet that reaches Foundry + Daytona.

```bash
docker build -t <acr>.azurecr.io/opencode-foundry:latest .
# push to ACR, then deploy to Container Apps/AKS with the .env values supplied
# as environment variables (use Azure Key Vault references for secrets).
```
- Assign the compute a **managed identity** with the **Cognitive Services OpenAI
  User** role on the Foundry resource (so `AZURE_AUTH_MODE=entra` works with no
  key).
- Provide the `opencode.json` to the container (mount it, bake it in, or supply
  the equivalent `AZURE_*` env vars).
- In the **Entra app registration**, add the redirect URI:
  `https://<app-base-url>/auth/callback`.

---

## Configuration reference (env)
| Variable | Purpose |
| --- | --- |
| `DAYTONA_API_URL` | Self-hosted Daytona control-plane base URL (in-VNet) |
| `DAYTONA_API_KEY` | Daytona API key |
| `DAYTONA_TARGET` | Optional Daytona target/region |
| `AZURE_FOUNDRY_BASE_URL` | Foundry base endpoint, e.g. `https://res.services.ai.azure.com` |
| `AZURE_API_VERSION` | Blank for v1 GA; else e.g. `2025-04-01-preview` |
| `AZURE_DEFAULT_DEPLOYMENT` | Default deployment name (matches Azure exactly) |
| `AZURE_AUTH_MODE` | `entra` (managed identity, default) or `apikey` |
| `AZURE_API_KEY` | Only if `AZURE_AUTH_MODE=apikey` |
| `AZURE_TOKEN_SCOPE` | Entra token scope (default cognitive services) |
| `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` | App SSO (blank disables sign-in) |
| `SESSION_SECRET` | Signs session cookies |
| `APP_BASE_URL` | Public app URL for the SSO redirect |

---

## How auth works
- **App access:** Entra SSO (MSAL auth-code flow). A signed, httpOnly session
  cookie (8h) gates the app and all `/api/*`. No GitHub, no passwords.
- **Foundry calls:** the launcher acquires a fresh **Entra token via the
  compute's managed identity** at each launch (`DefaultAzureCredential` →
  `cognitiveservices.azure.com/.default`) and injects it into the sandbox, so
  OpenCode authenticates to Foundry with a bearer token — **no API key stored**.
  (API-key mode is available as a fallback for non-managed-identity setups.)

> Token lifetime: tokens are acquired at launch. Very long-lived sessions may
> need a relaunch when the token expires; for interactive use this is rarely hit.

---

## Endpoints
| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | The app (requires SSO when enabled) |
| `GET` | `/healthz` | Health + config status |
| `GET` | `/api/me` | Sign-in status |
| `GET` | `/login`, `/auth/login`, `/auth/callback`, `/auth/logout` | Entra SSO |
| `POST` | `/api/launch` | Launch a (optionally named) workspace |
| `POST` | `/api/stop` | Stop/delete a workspace |
| `GET` | `/api/sandbox-status?id=...` | Poll a workspace until gone |
| `GET` | `/api/sandboxes` | List running workspaces (label-scoped) |

Sandboxes are labeled `app=opencode-foundry`; listing/stopping only touches ones
this app created. A workspace's display name is stored as a Daytona label.

---

## Notes / caveats
- **Must run in-VNet** for a private Foundry endpoint. Managed Daytona's cloud
  sandboxes can't reach a private endpoint — use **self-hosted Daytona in-VNet**.
- The exact Foundry URL shape (v1 vs deployment-based, `api-version` needed or
  not) varies by resource; `npm run setup` probes it and the config uses the
  `/openai/v1` form with `@ai-sdk/azure`. If your endpoint differs, adjust
  `opencode.json`'s `provider.azure.options.baseURL`.

## License
MIT
