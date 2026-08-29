# 02 Show skills for every host in the config TUI

Status: resolved
Type: task

## Requirement

The Skills screen must show what OpenCode, Codex, Claude Code, and Copilot can
load for the current project. One missing or slow CLI must not blank the other
hosts or prevent generated employee agents from retaining skills.

## Definition of done

- Every supported host has a visible count and discovery status.
- A shared skill names every host that can load it.
- OpenCode, Codex, and Copilot use native inventories when available.
- Documented filesystem roots cover missing, old, and slow CLIs.
- Claude symlinked personal skills and installed-plugin roots are followed.
- Codex employee generation and its pre-spawn cache use the resilient result.
- Tests cover native merge, fallback, enablement, and the rendered TUI.

## Answer

Implemented a merged cross-host inventory with native OpenCode, Codex, and
Copilot probes, Claude filesystem discovery, symlink-safe scanning, and bounded
fallbacks. The TUI and report show all four hosts, per-skill host availability,
and native/filesystem/unavailable status. Codex's fallback inventory now feeds
both generated employee definitions and the synchronous spawn cache.
