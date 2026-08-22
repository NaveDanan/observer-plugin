# 04 Claude adapter

Status: ready-for-agent
Type: task
Blocked by: 02
Owner seat: nia-okafor

Research: `docs/research/multi-provider/claude.html`

## Files owned

- `packages/cli/src/adapters/claude.ts` (new)
- `packages/cli/test/adapters/claude.test.ts` (new)

## Do

1. `profiles()` from `CLAUDE_CONFIG_DIR`, else `~/.claude`, plus the configured binary.
   Never override `HOME`; that relocates keychain lookup and hides credentials.
2. `catalogue()` from `claude --version` plus a versioned model list. Gate entries by the
   parsed version. Append user-supplied custom model strings with no descriptors.
3. Descriptors are independent, not one effort field: `effort`, `contextWindow`,
   `fastMode`, and `thinking` only for models that declare it.
4. Treat `ultrathink` as prompt text, not an API effort. Do not send it as `effort`.
5. `diagnose()` accepts aliases, full ids and deployment ids. Reject only empty.
6. `capabilities()` returns `childModel: "unsupported"` for now, with a note naming the
   generated-definition route as the future path.

## Definition of done

- No credential value is ever read, logged or stored.
- A model without a declared `thinking` option does not expose that toggle.
- Tests cover: missing binary, version gating, custom model passthrough, per-model option
  presence, and `ultrathink` never appearing as an effort value.

## Do not

- Do not run a live SDK probe in this ticket; it can execute credential-sensitive init.
- Do not write files into any Claude config directory.
