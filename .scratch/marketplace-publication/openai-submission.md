# OpenAI public directory submission preparation

Status: needs-info

The full local plugin is published at
https://github.com/NaveDanan/observer-plugin/tree/master/plugins/observer.

## Listing draft

- Name: Observer
- Short description: Watch and coordinate coding agents locally.
- Description: Observer displays coding-agent sessions and relationships on a local canvas, with prompts, replies, tool calls, and six employee specialties. The full local plugin requires Node.js 22.5+, a one-time runtime installation, lifecycle hooks, and a stdio MCP server.
- Website: https://github.com/NaveDanan/observer-plugin
- Support: https://github.com/NaveDanan/observer-plugin/issues
- Source license: MIT
- Publisher: awaiting the user's verified individual or business identity.
- Support email, privacy policy URL, terms URL, and availability: awaiting publisher details.

## Submission limitation

The current portal accepts skills-only or hosted MCP submissions. It requires a
public HTTPS URL for MCP. Observer's local stdio MCP server cannot be entered as
that URL. Do not expose a user's local daemon or telemetry publicly to satisfy
this requirement. A skills-only installation guide would be a narrower listing
and needs a self-contained skill bundle before submission.

The browser reached https://platform.openai.com/plugins, but a Cloudflare human
verification challenge prevented access to the authenticated submission form.
No OpenAI draft or submission has been created.

## Candidate review cases for a local setup skill

Positive: install on a clean supported computer; recognize an existing runtime;
open the local canvas; coordinate a backend and frontend task; inspect daemon
status without changing host settings.

Negative: unrelated coding request must not invoke Observer; do not enable a
second Observer hook installation; reject a downloaded release whose digest
does not match the pinned checksum.

Reference: https://developers.openai.com/plugins/deploy/submission
