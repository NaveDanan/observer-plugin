# 06 Grok adapter

Status: ready-for-agent
Type: task
Blocked by: 02
Owner seat: nia-okafor

Research: `docs/research/multi-provider/grok.html`

## Files owned

- `packages/cli/src/adapters/grok.ts` (new)
- `packages/cli/test/adapters/grok.test.ts` (new)

## Do

1. `profiles()` from the configured binary, default `grok`. Disabled by default, matching
   how t3code treats this provider.
2. `catalogue()` by running `grok --version`, then a scoped `grok agent stdio` ACP session,
   reading `availableModels` and `currentModelId` from session setup. Fall back to the
   single `grok-build` entry when discovery yields nothing.
3. Expose **no** reasoning descriptors. Current mainline t3code publishes none; the
   `reasoningEffort` work lives on an unmerged branch. Leave a comment naming that branch
   so the next person does not re-derive it.
4. Report auth as unknown even when a probe succeeds. The presence of `XAI_API_KEY` is not
   proof of a valid credential.
5. `capabilities()` returns `discovery: "live"`, everything else `"unsupported"`.

## Definition of done

- No effort picker is offered for any Grok model.
- A successful probe never claims authenticated.
- Tests cover: disabled by default, missing binary, empty inventory fallback, ACP failure,
  and absence of reasoning descriptors.

## Do not

- Do not implement the `_meta.reasoningEffort` shape from the unmerged branch.
- Do not treat a `session/set_model` request as evidence of the effective model.
