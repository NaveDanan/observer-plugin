# 02 Release and install the employee identity fix

Status: resolved
Type: task
Blocked by: 01

## Requirement

Cut the next patch release, publish its commit and tag, and install that exact
release into OpenCode, Codex, and GitHub Copilot.

## Definition of done

- Version 0.9.17 is built and verified from its release tarball.
- The release commit and `v0.9.17` tag are on the origin remote.
- A GitHub release contains the 0.9.17 tarball.
- OpenCode, Codex, and GitHub Copilot report the new installation.

## Answer

Released Observer 0.9.17 with the native Codex employee identity fix. The
release tarball passed the full test and build pipeline, and the installed CLI
passes `observer doctor`. OpenCode has the refreshed plugin source, Codex has
the cache-busted 0.9.17 plugin, and GitHub Copilot lists Observer 0.9.17.
