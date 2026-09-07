# Public plugin installation

Observer is distributed through the `observer-public` repository marketplace.
This does not imply approval for either host's default public catalog.

## Codex

```sh
codex plugin marketplace add NaveDanan/observer-plugin
codex plugin add observer@observer-public
```

Restart the desktop app and select **Observer Public** in the Plugins directory.
Ask **Set up Observer for this computer**, then restart Codex and trust the
Observer hooks through `/hooks`.

## GitHub Copilot

```sh
copilot plugin marketplace add NaveDanan/observer-plugin
copilot plugin install observer@observer-public
```

Restart Copilot and ask **Set up Observer for this computer**. Restart again
after setup so the MCP server can connect. Observer appears in the Plugins
view under the `observer-public` marketplace.

## Runtime and data

Node.js 22.5+ and npm must be on PATH for the desktop app and CLI. Setup downloads
the published v0.9.21 release from GitHub, verifies its SHA-256 digest, and installs
it with npm under `~/.observer/runtimes/0.9.21`. It does not install global npm
commands. Routine hooks never download dependencies. Before setup, telemetry
hooks exit quietly and the MCP server reports the missing runtime.

Setup installs missing Codex employee definitions without replacing existing
ones. Copilot receives its six default employee agents directly from the plugin.
Public packages use the default roster; custom employee/model configuration
continues to use the existing local installer documented in the main README.

The runtime keeps session events, prompts, responses, tool calls, coordination
messages, and its SQLite database in `~/.observer` (or `OBSERVER_HOME`). Its daemon
binds to `127.0.0.1`. Setup contacts GitHub and npm; Observer does not upload agent
data to a cloud service. Data handled by the coding host or model provider remains
subject to that provider's policies. Keep the local directory private if working
with confidential repositories.

Use one Observer plugin or hook installation per host. Disable an existing
`observer-local` plugin or remove plain Observer hooks before enabling the public
plugin, to avoid duplicate events. Disabling a plugin stops its hooks and MCP
tools; it does not stop the shared daemon or erase stored data. From the installed
plugin folder, `node scripts/cli.mjs stop` stops the daemon.

## Maintaining the catalog

`node scripts/build-marketplace.mjs` generates both plugin folders from the
default roster and shared host event lists. Runtime launchers come from
`scripts/plugin-runtime`. Run `node --test scripts/test-marketplace.mjs` after
regeneration. Update the pinned version, URL, and checksum in the generator only
after uploading and verifying the corresponding release asset.

The catalog manifests use the formats documented by
[OpenAI](https://developers.openai.com/plugins/build/plugins) and
[GitHub](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace).

## Default catalog submissions

GitHub's `github/copilot-plugins` catalog accepts pull requests for external
plugins. Inclusion requires maintainer review and merge.

The universal OpenAI Plugins directory uses the
[submission portal](https://platform.openai.com/plugins). Its current submission
types are skills, hosted MCP, or both. Observer's full plugin uses local hooks
and a stdio MCP server, so the repository package cannot be submitted as a hosted
MCP service without a separate deployment and changes to its data model. A
skills-only listing can guide installation, but must describe that scope honestly.
Submission also requires the publisher's verified identity, support and policy
URLs, availability, and review attestations. See the
[submission requirements](https://developers.openai.com/plugins/deploy/submission).
