# Observer for GitHub Copilot

Watch coding agents on a local canvas and coordinate work with six employee specialties.

Requires Node.js 22.5+ with npm. After installing the plugin, ask **Set up Observer for this computer**. Setup downloads the checksum-pinned [v0.9.21 runtime](https://github.com/NaveDanan/observer-plugin/releases/download/v0.9.21/observer-ai-0.9.21.tgz), installs it in ~/.observer/runtimes/0.9.21, and starts the local daemon. Restart the host after setup; Codex also requires trusting hooks with /hooks.

The plugin records local session events, prompts, tool calls, replies, and agent relationships in ~/.observer. The daemon binds to 127.0.0.1. Setup contacts GitHub and npm; agent data is not sent to an Observer cloud service. Existing host/model services retain their own data policies.

Use only one Observer hook/plugin installation per host. The dashboard switch disables this plugin's hooks and tools; it does not erase data or stop the shared daemon. Run scripts/cli.mjs stop to stop the daemon.

[Source and support](https://github.com/NaveDanan/observer-plugin) · [License](https://github.com/NaveDanan/observer-plugin/blob/master/LICENSE)
