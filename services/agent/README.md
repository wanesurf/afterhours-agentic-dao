# Hosted Hermes integration

Hosted Hermes is the reasoning and orchestration layer. This directory contains
the configuration template, system prompt, Afterhours skill, and runtime
interfaces owned by this repository. Hermes itself is hosted externally.

The hosted instance currently uses `anthropic/claude-sonnet-5` through Nous.
The website uses the main `default` profile in read-only mode. No separate
holder profile is required. Its official Pyth MCP connection is limited to
public feed discovery: Pyth's hosted price tools require the API key in a
model-visible `access_token` argument. Do not put that key in a prompt or
Hermes tool call. See `config/hermes.config.template.yaml`.

The target architecture connects Hermes to:

- The official hosted Pyth MCP for public feed discovery.
- The read-only Afterhours Arbitrage MCP for server-side Pyth Pro prices and
  deterministic opportunity detection. This service exists locally but is not
  deployed or connected to hosted Hermes yet.
- The Afterhours Execution MCP for policy-gated simulation and execution
  after its implementation and verification.

No unrestricted wallet, shell, or generic transaction tool is enabled in the
main agent configuration. The website chat is open to everyone with anonymous
browser sessions and no wallet or token requirement. Its server-side proxy uses
`HERMES_API_URL` and `HERMES_API_KEY` for the main API. The hosted dashboard
itself may not expose that API. The main template sets
`platform_toolsets.api_server: []`; public market evidence comes from the web
backend. Each turn checks the advertised model and rejects enabled API tools.
The CLI can retain its read-only discovery tools. See `apps/web/README.md`.
