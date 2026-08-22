# Audit: tickets 01 and 08

Reviewed against `.scratch/multi-provider-seats/spec.md`, issues 01 and 08,
`CONTEXT.md`, and the Provenance, Idempotency, and Order tolerance sections of
`docs/architecture.md`.

## Verification

- `node_modules/.bin/vitest run apps/daemon`: **10 test files passed, 250 tests passed**.
- `node_modules/.bin/vitest run packages/core`: **3 test files passed, 50 tests passed**.
- The live `/home/naved/.observer/config.json` has five employees with both legacy top-level `model` and `variant` fields, plus one model-only employee. An exact temporary copy loaded with all legacy fields intact; `diagnoseSeats` returned `ok: true`, `effective: true`, and no issues. `saveConfig(loadConfig())` produced byte-identical output for that copy.
- The current SQLite `Store` path was also probed directly, including close and reopen. Agent totals and the per-tool-call churn ledger survive persistence, so storage is not a finding here.

## Must Fix Before This Ships

### 1. P1: The churn ledger cannot reconcile better evidence or a status flip

**Change request:** Replace the one-way guard at `packages/core/src/reduce.ts:663-670` with explicit per-call contribution state that can replace an inferred or partial term and adjust the agent aggregate by the delta. Preserve the lower-fidelity term when a later delivery is weaker, but accept a stronger or more complete delivery exactly once.

The ordinary cases are sound: an exact duplicate `tool.finished` does not add again, finish-before-start can be completed when the input arrives, and failed-then-successful counts once. The claim is still too broad for the cases that matter most:

- A start containing only `oldString` is credited as `+0` when it finishes; a later start with `newString` is blocked by the ledger.
- An inferred contribution is never replaced by later host-stated counts, despite `extractChurn` preferring authoritative data at `packages/core/src/reduce.ts:728-731`.
- `tool.finished` unconditionally changes status at `packages/core/src/reduce.ts:251-254`. A successful counted call followed by a failed redelivery ends with `status: "error"` while its churn remains in the agent total. Define and test whether a late failure is ignored as a downgrade or retracts the contribution.

The sparse-input problem begins at `packages/core/src/reduce.ts:217-220`: a non-null, less complete `tool.started.input` replaces a richer object. Retain the richer capture or merge JSON records before attempting churn extraction.

### 2. P1: Write and partial edit paths manufacture zeroes

**Change request:** Fix `packages/core/src/reduce.ts:737-744` and `:774-787` so an unknown side of a change stays absent, rather than becoming numeric zero. A `write` reveals the new content but not how many lines it replaced; its current `linesRemoved: 0` is the `-0` the requirement forbids. A missing `oldString` or `newString` is not proof of an empty string. `multiedit` inherits the same error through `editChurn` at `:754-759`.

Use independently optional contribution sides, or skip a contribution until the required evidence exists. Count zero only when the empty string was actually present in the host input. Add overwrite, missing-old-half, and missing-new-half tests. The UI already knows how to render one present side, so there is no need to force a false pair.

### 3. P1: Redaction and truncation are counted as if they were host arguments

**Change request:** Carry an explicit redacted/truncated marker through normalization, or omit edit/write arguments from churn accounting whenever `apps/daemon/src/pipeline.ts:157-161` transforms them. `redactValue` can replace multiline content with `[redacted]` or append a truncation marker; `packages/core/src/reduce.ts:733-744` then counts that transformed string as the file content. The reducer comment at `:673-675` claims stripped input remains unmarked, but capture policy currently supplies a different string rather than `undefined`.

Add an integration test through `Pipeline`, not only a direct reducer test. Otherwise a number derived from redaction is neither host-stated nor a trustworthy inference from the original argument.

### 4. P1: Patch validation accepts marker-shaped prose and empty markers

**Change request:** Make `patchChurn` at `packages/core/src/reduce.ts:791-810` validate the supported unified/apply-patch grammar, not merely any line beginning `@@` or `*** `. Inputs such as `@@ not a hunk\n+fabricated` and `*** not a patch\n+fabricated` currently produce additions. A marker-only string returns inferred `0/0`, although no changed line was stated. Return no contribution for malformed or content-free patches, and add both adversarial cases to the test at `packages/core/test/reduce.test.ts:418-432`.

### 5. P1: Arbitrary output is promoted to authoritative churn and decimals are changed

**Change request:** Restrict `statedChurn` at `packages/core/src/reduce.ts:825-839` to an adapter-declared, typed host result or an explicit normalized marker. Any JSON tool output containing `additions` and `deletions` is currently treated as host-stated churn even though it may be unrelated metadata. Also change `pickCount` at `:862-867` to require `Number.isInteger(value)`; `{ "linesAdded": 1.9, "linesRemoved": 0 }` is currently stored as authoritative `1`, a number the host did not state.

Add tests for decimal counts and generic JSON output with those keys. Provenance must not say `authoritative` unless the adapter has identified the fields as churn.

### 6. P1: The new target schema drops data that was previously passthrough

**Change request:** Preserve raw malformed values while exposing a validated view in `apps/daemon/src/seats.ts:210-269`.

- `targets: "sentinel"` is dropped by `:266`; before `targets` was a declared field, the surrounding `.passthrough()` retained it.
- A target entry such as `targets.t: 7` becomes `{ host: "" }` through `SeatTargetSchema.catch` at `:240-250`, losing the original value. The test at `apps/daemon/test/seats.test.ts:416-423` currently asserts this destructive result.
- `SeatTargetOptionSchema` at `:210-213` strips unknown option keys, so `{ id: "x", value: "high", future: 42 }` loses `future`.

Keep valid sibling fields and unknown keys through save, and add round-trip tests for malformed target maps, malformed target entries, and option-level extensions. Unknown employee ids and target-level passthrough fields are otherwise preserved correctly.

### 7. P1: A malformed provider driver drops valid siblings

**Change request:** Make `driver` field-level at `apps/daemon/src/providers.ts:57-71`. `{ driver: 42, displayName: "Local", binaryPath: "/x", note: "keep" }` currently hits the object-level catch and becomes `{}`, losing the sibling and passthrough fields. Use a diagnosable empty fallback for the driver while retaining the rest of the entry, and add that exact regression. The existing provider test only proves that a broken entry does not remove a valid sibling entry.

### 8. P1: The OpenCode validator does not expose the required adapter-facing finding contract

**Change request:** Add the `SeatFinding` contract promised by ticket 01 and make the OpenCode validator boundary accept the target/profile context and return `SeatFinding[]`, or make `diagnoseOpencodeModel` private and have the adapter's `diagnose` method own that shape. `apps/daemon/src/seats.ts:429-443` currently accepts a bare model plus a caller-built dotted path and returns one optional `SeatIssue`; an adapter must know shared config-path syntax, and the named `SeatFinding` type is absent. Keep the slash predicate OpenCode-owned, but do not make every adapter caller reconstruct it. Add an adapter-level integration assertion, not only the direct helper tests at `apps/daemon/test/seats.test.ts:637-668`.

## Worth Considering

### 9. The slash-rule move is correct, but complete diagnosis is not merged at the daemon API

Moving `includes("/")` out of shared `diagnoseSeats` is the right architectural decision. Codex `gpt-5.6-sol` and Grok `grok-build` must not fail a host-agnostic diagnosis, and the OpenCode adapter does call the rule for its own target. No desired model is written onto an observed `AgentEntity.model`; that separation is sound.

If `/v1/config` is the canonical diagnosis endpoint, also merge host findings there; `apps/daemon/src/server.ts:577-586` currently returns only `diagnoseSeats`, so an explicit malformed OpenCode target is absent from that response.

### 10. The migration helper is sound but is not wired to a target-writing save

`migrateSeatSpecToTargets` at `apps/daemon/src/seats.ts:403-412` correctly leaves a no-op load/save alone, removes only the legacy pair when migration is requested, preserves unknown seat fields, and does not mutate its input. There is no production call site, however. The current CLI save at `packages/cli/src/config-ui.ts:187-190` and the daemon config save at `apps/daemon/src/server.ts:173-175` persist the working seat object as-is. Wire the helper only at the boundary that actually materializes `targets`, and test that a target edit removes only `model` and `variant`. Do not invoke it for a generic no-op save.

### 11. The `seatTargets` copy is shallow

The copy promise at `apps/daemon/src/seats.ts:372-375` protects deletion of a target key but shares target objects and option arrays. Mutating `seatTargets(spec).t.options[0].value` mutates the config. Either deep-copy the JSON-shaped target data or narrow the promise. The test at `apps/daemon/test/seats.test.ts:476-480` would pass while this nested mutation remains.

### 12. Clarify that two calls touching one file measure gross call churn

The call-id ledger deliberately counts two different tool call ids separately, even when both edit the same `filePath`. That is sound for the ticket's per-completed-call metric and is necessary to avoid conflating distinct host operations. It is not the repository's final net diff. Add a test or state this explicitly in `packages/protocol/src/entities.ts:50-70`; otherwise the browser label `Code churn` will invite a stronger interpretation than the data supports.

## Test Quality

These new tests are useful but do not prove the stronger behavior their names or comments suggest:

- `packages/core/test/reduce.test.ts:297-314`, `does not double-count when the same tool-result event is applied twice`, proves exact replay with the same payload. It does not test a distinct redelivery with improved or conflicting evidence.
- `packages/core/test/reduce.test.ts:434-456`, `takes host-stated counts as authoritative`, sees authoritative data on the first finish. It would pass if inferred totals could never be upgraded to authoritative totals.
- `packages/core/test/reduce.test.ts:379-389`, `never lets a late event decrease a count`, uses `input: undefined`; it would pass even though an object with fewer fields currently overwrites richer input.
- `packages/core/test/reduce.test.ts:341-348`, `records zero for an edit that genuinely changed nothing`, checks only aggregate zeros. It would pass if the zero contribution never marked the tool-call ledger, because replaying an unmarked `0/0` still leaves the aggregate at zero.
- `packages/core/test/reduce.test.ts:325-338`, `contributes nothing when the tool result states no churn`, checks only agent fields. It would pass if the no-churn tool row were incorrectly marked with a `0/0` ledger.
- `packages/core/test/reduce.test.ts:418-432` rejects prose with no marker, but not marker-shaped prose or marker-only input.
- `apps/daemon/test/seats.test.ts:278-290` calls its synthetic employee assertion byte-for-byte coverage but compares only `seats.employees`. It would pass if a no-op save added, removed, or reordered unrelated top-level config fields.
- `apps/daemon/test/seats.test.ts:416-423` passes while malformed target data is lost because it asserts the lossy `{ host: "" }` replacement.

## Desired Versus Observed

No finding. Seat specs and targets remain desired configuration. `reduce.ts` has no seat-config dependency and populates `AgentEntity.model` only from normalized host events. The generated OpenCode definition is a control artifact, not an observed-agent model. The provenance distinction is conceptually right, although the generic-output and redacted-input paths above can overstate confidence.

## What Could Not Be Verified

- I did not run a browser session or the full repository test suite.
- I did not run the CLI suite; it was outside the two requested verification commands.
- I did not validate the actual current output schema of every host tool, so the generic `additions`/`deletions` authority risk is based on the reducer contract and constructed inputs.
- I did not exercise a live OpenCode registry or a live adapter control operation. No production source or live config was modified during this audit.
