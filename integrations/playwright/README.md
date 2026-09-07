# Optional browser tools

[mcp.json](mcp.json) is an optional Playwright MCP configuration for browser
work by Arjun, Sofia, and Daniel. It is not loaded or installed by Observer.
It requires Node.js, npm, browser dependencies, and an MCP-capable host.

Use the host's supported MCP registration flow to add this server. The example
uses the `mcpServers` container used by several clients; Codex uses TOML server
configuration and OpenCode uses its own MCP configuration, so adapt the container
through that host's documented registration flow. Preserve the executable and
arguments. On Windows, select `npx.cmd` when the host requires a Windows command
launcher.

The example follows the upstream package's `@latest` setup. For a reproducible
team configuration, replace `latest` with a reviewed version and record it in
the project. After connecting, list the exposed tools and check a local test
page before relying on it. Each parallel employee needs a separate isolated
context. `--isolated` keeps browser state in memory; it does not restrict network
access or create an operating-system sandbox. Coordinate ownership if the host
shares one MCP connection across employees.

This provides browser automation, not native desktop control. Existing logged-in
tabs are not automatically inherited. When the task requires desktop apps, use
the current host's actual computer-use tools and their instructions, or report
the missing capability. Do not copy another host's proprietary tool names into
an employee definition and claim they are installed.

Configuration and isolation behavior come from the
[official Microsoft Playwright MCP documentation](https://github.com/microsoft/playwright-mcp).
