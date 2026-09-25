# Afterhours landing page and open agent conversation

A plain HTML/CSS/JavaScript landing page using the supplied classical assembly
banner and Roman-inspired styling, served by the existing Node/TypeScript web service.

## Run locally

```sh
pnpm install
pnpm build
# Optional: copy .env.example to .env and fill server-only connection values.
node --env-file-if-exists=.env dist/apps/web/src/server.js
```

Open **http://localhost:8780/**. `WEB_PORT`, `WEB_HOST`, and `WEB_ORIGIN`
control the listener and exact request origin. Use `localhost`, not
`127.0.0.1`, in the browser when the origin is configured as `localhost`.
The old market monitor is preserved at **/markets**. Without a Pyth key it
explicitly displays illustrative sample data.

## Implemented

- A Roman-inspired manifesto at `/manifesto`, reached through the landing page’s
  “Learn more” link. Five articles describe the assembly, mandate, treasury,
  public record, and future institution. The page works without JavaScript.

- Original user-supplied assembly banner, locally bundled Marcellus and Geist.
- Static Roman-inspired design with limestone, deep olive, and bronze details.
  GSAP and its dependency have been removed; there is no automatic motion.
- Responsive explanation of the problem, governance, and development status.
- Open read-only chat with no wallet connection, signature, or token check.
- Automatic anonymous one-hour sessions in HTTP-only, SameSite=Strict cookies;
  Secure and `__Host-` prefix on HTTPS. No localStorage credentials.
- Browser-session isolation, bounded history, new-chat reset with a new Hermes
  conversation ID, origin checks, request-size limits, IP/session rate limits,
  single active turn per session, and a global four-turn concurrency cap.
- Eight completions per session per minute and twenty per IP per minute.
  Changing cookies cannot bypass the IP completion limit.
- Text-only replies rendered with `textContent`; no model HTML execution.

## Connect the read-only Hermes agent

The website uses the main **default** Hermes profile. No holder profile, wallet
verification, or separate holder credential is required.

Set these server-side variables in the local `.env` or Railway `afterhours-web`:

```dotenv
HERMES_API_URL=https://<public-api-host>
HERMES_API_KEY=<main-agent-api-server-key>
# Optional when /v1/models advertises exactly one ID:
HERMES_API_MODEL=
```

The URL is the API base **before `/v1`**, not a dashboard login URL. Use the
existing default profile's `API_SERVER_KEY`. HTTPS is required except local
loopback. Keys are never sent to the browser or committed to the repository.
The old `HERMES_HOLDER_API_*` variables are no longer read.

The hosted gateway uses one shared listener. Configure that listener on the
**default** profile; do not enable another listener on a named profile. Preserve
its existing host/port settings until the hosting provider's public route is
verified. A dashboard reporting "Connected" does not prove external API access.

Apply `platform_toolsets.api_server: []` from
`services/agent/config/hermes.config.template.yaml` to the main agent. Other
surfaces may retain their existing read-only discovery tools. The website
supplies public market evidence and fixed system instructions server-side.

Before each reply, the backend reads `/v1/models` and `/v1/toolsets`. It selects
the single advertised model, or verifies an explicit `HERMES_API_MODEL` against
the advertised IDs. Ambiguous/malformed model discovery and any enabled API
tools block completion. The browser cannot choose the model or tools.

Independent random conversation IDs scope sessions. Keep private operator context
and global cross-conversation recall out of the public agent. The main profile is
read-only; an instruction in a prompt is not a substitute for disabled tools.

Live replies require a verified public API endpoint and a successful completion.
Until then, the website reports that the connection is unavailable.

Official setup: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

## Storage / deployment boundary

This version has a bounded in-memory store for **one web process**. A restart
invalidates sessions and loses local transcripts. A new chat drops
the website copy; Hermes may retain its own records. The UI discloses that.
Do not deploy multiple replicas until sessions, history,
rate limits and locks use a shared atomic store. Forwarded IP headers are deliberately not trusted;
behind a proxy the IP limiter is shared until trusted proxy handling is added.

No wallet transfer, trade, proposal submission, or transaction signing endpoint
is exposed.

## Railway deployment

The canonical site is https://afterhouragent.xyz in the
`afterhours-web` service of the existing Afterhours Railway project. The legacy
agent and migration services remain separate. No Git repository was published.

`Dockerfile` builds the TypeScript server and static assets. `.dockerignore` and
`.railwayignore` exclude local credentials and development files. The process
uses Railway's `PORT`, binds to `0.0.0.0`, and derives the exact HTTPS origin
from `RAILWAY_PUBLIC_DOMAIN` unless `WEB_ORIGIN` is explicitly configured.
Production sets `WEB_ORIGIN=https://afterhouragent.xyz`. The root domain is
attached to `afterhours-web`; `migration.afterhouragent.xyz` remains attached
to the separate migration service. The Railway-generated address is an
infrastructure endpoint, not the canonical site URL.
`railway.json` configures one replica and the `/health` check.

At deployment on 2026-09-25, the page, assets, and public secure sessions passed
live checks. Hermes replies remain unavailable pending API channel activation
and a verified external API endpoint. The market monitor uses labeled sample
data until `PYTH_PRO_ACCESS_TOKEN` is configured in the Railway secret store.

## Verification

`pnpm test` includes public-session creation without wallets, expiration,
conversation isolation/reset, cross-origin denial, API override rejection,
IP/session completion limits, unavailable-agent behavior, and Hermes capability
checks. Existing wallet-verification unit tests cover the retained optional
holder-auth helper; it is not used by the public chat routes.

Design provenance: `docs/landing-page.md`.
