# Publication status

Status: needs-info

## Published

- Source/catalog commit: `78b35f09161aa8758e8510a309db3117ac3e2018` on public `master`.
- Codex catalog: `.agents/plugins/marketplace.json`, marketplace `observer-public`.
- Copilot catalog: `.github/plugin/marketplace.json`, marketplace `observer-public`.
- Installation guide: https://github.com/NaveDanan/observer-plugin/blob/master/docs/marketplace.md
- Copilot default catalog submission: https://github.com/github/copilot-plugins/pull/85 (open; awaiting maintainers).

## Verified

- Codex plugin schema and both skill frontmatter validators passed.
- Three portable-launch/catalog tests passed, including every generated Windows
  telemetry command running from a path with spaces.
- Clean Copilot installs passed from a local catalog and the public GitHub catalog.
- Codex and Copilot fetched and registered the public GitHub marketplace.
- Setup downloaded v0.9.21, matched the published SHA-256, installed npm dependencies,
  and started the daemon. A second setup/start/stop cycle passed.
- MCP initialization and discovery exposed employee_brief, agent_identity,
  agent_send, agent_inbox, and agent_ack.
- A synthetic Codex SessionStart reached the isolated daemon's sessions API.
- The smoke-test daemon was stopped afterward. Existing user daemon/config was
  not replaced. The normal clients have the public marketplace registered, but
  existing local Observer plugin installations were retained.

## Remaining

The universal OpenAI directory submission has not been created. The portal is
behind a human-verification challenge, publisher identity/details are pending,
and its current hosted-MCP/skills submission format does not accept Observer's
full local hooks plus stdio MCP package directly. See `openai-submission.md`.

Do not mark default-catalog publication complete until GitHub merges the catalog
entry and OpenAI accepts and publishes a supported submission.
