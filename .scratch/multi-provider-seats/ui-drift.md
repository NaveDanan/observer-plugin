# UI drift report — multi-provider seats

Author: Elias Mercer (DevOps/SRE), acting as drift tracker
Watch window: 2026-08-22T22:09:44+03:00 → 2026-08-22T22:20:28+03:00 (~11 min, 14 polls)
Mode: read-only. Nothing in this repo was modified except this file.

**Headline: the parallel agent is not "editing the web UI". They are implementing
this spec's own tickets 01 and 08, live, right now. The blast radius overlaps our
work almost exactly. Read the two lists at the bottom before touching anything.**

---

## 1. Baseline

```
git rev-parse --short HEAD  →  30b83c5
```
`30b83c5 Bump version to 0.4.0; config TUI main menu, seat control row, Forgeline colour`

### `git status --short` at 22:09:44

```
 M apps/daemon/src/config.ts
 M apps/daemon/src/index.ts
 M apps/daemon/src/server.ts
 M apps/web/package.json
 M apps/web/src/api.ts
 M packages/cli/src/models.ts
 M packages/storage/src/store.ts
 M pnpm-lock.yaml
?? .scratch/multi-provider-seats/
?? apps/daemon/src/models.ts
?? apps/daemon/src/providers.ts
?? apps/daemon/test/config-api.test.ts
?? apps/web/src/employee-card.css
?? apps/web/src/index.css
?? apps/web/src/lib/
?? apps/web/src/settings/
?? apps/web/src/theme/
?? apps/web/src/ui/
?? docs/research/
```

### `git diff --numstat` at 22:09:44

```
36	5	apps/daemon/src/config.ts
4	1	apps/daemon/src/index.ts
114	1	apps/daemon/src/server.ts
6	1	apps/web/package.json
127	0	apps/web/src/api.ts
12	580	packages/cli/src/models.ts
6	1	packages/storage/src/store.ts
375	15	pnpm-lock.yaml
```

At baseline `apps/daemon/src/seats.ts`, `packages/core/src/reduce.ts`,
`packages/protocol/src/entities.ts`, `apps/web/src/styles.css`,
`apps/web/src/main.tsx`, `apps/web/index.html`, `apps/web/src/layout.ts` and
`apps/web/src/employeeCard.ts` were **all clean**. Every one of them was dirty by
22:20. That is the whole story of this report.

---

## 2. Inventory of in-flight work under `apps/web/` and `apps/daemon/`

### Daemon

| Path | Size | What it does |
| --- | --- | --- |
| `apps/daemon/src/models.ts` | 25 KB / 580 ln | Model catalogue moved wholesale out of `packages/cli/src/models.ts`; reads OpenCode's `~/.cache/opencode/models.json`, narrows by `auth.json`, falls back to `opencode models --verbose`. |
| `apps/daemon/src/providers.ts` | 73 ln (was 20) | `ProviderInstanceConfig` + zod schemas for configured provider instances keyed by user instance id. **Grew 20→73 during the watch.** |
| `apps/daemon/src/config.ts` | +36/-5 | Adds `providers` to `ObserverConfig`, exports `CaptureConfigSchema`, `RedactionConfigSchema`, `ConfigSchema`, and a new strict `ConfigPatchSchema`. |
| `apps/daemon/src/server.ts` | +114/-1 | New REST surface: `GET/PUT /v1/config` (l.121/126), `GET /v1/models` (l.164), `GET /v1/providers/status` (l.187). |
| `apps/daemon/src/index.ts` | +4/-1 | Re-exports the new modules. |
| `apps/daemon/src/seats.ts` | +363/-17 | **ACTIVE.** Adds `SeatTarget`, `SeatTargetOption`, `targets`, `LEGACY_TARGET_ID = "opencode:default"`, host-agnostic opaque model ids. This *is* spec ticket 01. |
| `apps/daemon/test/seats.test.ts` | +392/-9 | **ACTIVE.** Tests for the above. Was clean at baseline. |
| `apps/daemon/test/config-api.test.ts` | 6.8 KB / 193 ln | New tests for the `/v1/config` round trip. |

### Web — new Tailwind v4 settings island

| Path | Size | What it does |
| --- | --- | --- |
| `apps/web/src/settings/SettingsPage.tsx` | 9.5 KB / 229 ln | Full-window settings surface: left search rail + one scrolling column, one route per tab. |
| `apps/web/src/settings/useConfig.ts` | 3.1 KB / 96 ln | Module-level `useSyncExternalStore` config store; optimistic writes, daemon response authoritative. |
| `apps/web/src/settings/search.ts` | 2.8 KB / 47 ln | Hand-written settings search index (16 entries) with `id`/`tab`/`keywords`. |
| `apps/web/src/ui/primitives.tsx` | 29 KB / 829 ln | Design system: `Button`, `Input`, `Switch`, `Select`, `Popup`, `Dialog`, `NumberField`, `Slider`, `SettingsSection`, `SettingsRow`, `SettingResetButton`. |
| `apps/web/src/theme/palettes.ts` | 40 KB / 888 ln | Theme palette data. |
| `apps/web/src/theme/library.ts` | 22 KB / 547 ln | Theme library. |
| `apps/web/src/theme/useTheme.ts` | 14 KB / 402 ln | Theme hook. |
| `apps/web/src/theme/colors.ts` | 14 KB / 378 ln | Colour maths. |
| `apps/web/src/theme/appearance.ts` | 6.6 KB / 182 ln | Appearance (light/dark/system) state. |
| `apps/web/src/lib/utils.ts` | 253 B / 7 ln | `cn()` clsx + tailwind-merge helper. |
| `apps/web/src/index.css` | 26 KB / 716 ln | New Tailwind v4 entrypoint + tokens. |
| `apps/web/src/app-surfaces.css` | new | **APPEARED DURING WATCH.** Canvas/node styles carved out of the deleted `styles.css`. |
| `apps/web/src/employee-card.css` | 6.9 KB / 216 ln | Employee card geometry carved out of `styles.css`. |
| `apps/web/src/__verify-index.css` | new | **APPEARED DURING WATCH.** Throwaway scratch file `main.tsx` currently imports. Unambiguous mid-experiment marker. |
| `apps/web/src/api.ts` | +127/-0 | Settings client: `SeatSpec`, `SeatsConfig`, `SeatDiagnosis`, `ProviderInstanceConfig`, `ObserverConfigView`, `getConfig`, `updateConfig`, `ModelInfo`, `ModelCatalogue`, `getModels`, `getProviderStatus`. |
| `apps/web/package.json` | +6/-1 | Adds `tailwindcss@4`, `@tailwindcss/vite`, `lucide-react`, `clsx`, `tailwind-merge`. |

### Component structure and how config reaches the browser

`SettingsPage` is a fixed full-window surface (not a modal). Left `<nav>` holds a
`/`-focused search `Input` over `SETTINGS_SEARCH_INDEX`; when the query is empty it
renders the tab list, when non-empty it renders ranked results that `jumpTo()` a
`(tab, rowId)` pair. The right column is a `SettingsSearchTargetProvider` wrapping a
scroll container that mounts exactly one of `<GeneralPanel/>`, `<AppearancePanel/>`,
`<ProvidersPanel/>` (`SettingsPage.tsx:220-222`).

**Those three panel files do not exist on disk.** `SettingsPage.tsx:14-16` imports
them; `ls apps/web/src/settings/` returns only `SettingsPage.tsx`, `search.ts`,
`useConfig.ts`. The web tree does not typecheck right now. This is a half-written
feature, not a finished one.

Config path to the browser:
`apps/daemon/src/config.ts` (zod, disk authority)
→ `GET/PUT /v1/config` in `apps/daemon/src/server.ts:121,126`
→ `api.getConfig()` / `api.updateConfig()` in `apps/web/src/api.ts:154,158`
→ module-level store in `useConfig.ts` (single shared copy, optimistic write, daemon
response replaces local state wholesale so normalisation wins)
→ `useObserverConfig()` in panels.

Nothing in `apps/web/src/App.tsx` or `main.tsx` imports `SettingsPage` yet — the whole
settings island is currently unreachable from the running app.

---

## 3. Answers

### Does the settings UI have an Employees or Seats tab?

**No tab.** `SettingsPage.tsx:21` declares exactly:

```ts
export type SettingsTab = "general" | "providers" | "appearance"
```

rendered in the order General, Appearance, Providers (`SettingsPage.tsx:23-27`).

**But employees are already claimed as sections inside General.** `search.ts` indexes:

```ts
{ id: "setting-employees",    title: "Employees",    tab: "general", keywords: "roster seat persona subagent" },
{ id: "setting-seat-control", title: "Seat control", tab: "general", keywords: "model effort override agent" },
```

So the intended home for per-employee model config is `GeneralPanel.tsx` — a file that
does not exist yet and which the parallel agent is on the hook to write. Anyone who
creates `GeneralPanel.tsx` will collide head-on.

### Files a per-employee model selection change in the browser must touch

1. `apps/web/src/settings/GeneralPanel.tsx` — **does not exist yet**; owns rows
   `setting-employees` and `setting-seat-control`.
2. `apps/web/src/api.ts` — `SeatSpec`/`SeatsConfig` (l.106-116), `ModelInfo`/
   `ModelCatalogue`/`getModels` (l.172-192), `ConfigPatch` (l.152).
3. `apps/web/src/settings/useConfig.ts` — `saveConfig` patch path.
4. `apps/web/src/settings/search.ts` — row ids must stay in step with the panel.
5. `apps/web/src/ui/primitives.tsx` — `Select` (l.307, has `group` support, ideal for
   provider-grouped models), `SettingsSection` (l.727), `SettingsRow` (l.757).
6. `apps/daemon/src/seats.ts` — the `SeatSpec`/`SeatTarget` schema. **ACTIVE EDIT.**
7. `apps/daemon/src/server.ts` — `/v1/config`, `/v1/models`.
8. `apps/daemon/src/models.ts` — catalogue and variants.
9. `apps/daemon/src/config.ts` — `ConfigPatchSchema` is `.strict()`, so any new seat
   field fails validation until it is added here.

### Files an agent-node / detail-panel change must touch

1. `apps/web/src/AgentNode.tsx` — node body.
2. `apps/web/src/DetailPanel.tsx` — detail pane.
3. `apps/web/src/App.tsx` — node wiring; `.diff-badge`/`.diff-add` at l.181-182.
4. `apps/web/src/store.ts` — client entity state.
5. `apps/web/src/Canvas.tsx` — canvas host.
6. `apps/web/src/layout.ts` — `NODE_WIDTH` / reserved heights, must stay in sync with
   `.employee-node` CSS. **CHANGED during watch.**
7. `apps/web/src/app-surfaces.css` — where `.employee-node` now lives.
   **`styles.css` is gone; do not target it.**
8. `packages/protocol/src/entities.ts` — `linesAdded`/`linesRemoved`/
   `churnConfidence`. **CHANGED during watch.**
9. `packages/core/src/reduce.ts` — `creditChurn` reducer. **CHANGED during watch.**

### Are DetailPanel / AgentNode / App / store / styles.css untouched?

| File | Baseline | Now | Verdict |
| --- | --- | --- | --- |
| `apps/web/src/DetailPanel.tsx` | clean, mtime 08:49 | clean | **Untouched since HEAD.** |
| `apps/web/src/AgentNode.tsx` | clean, mtime 16:53 | clean | **Untouched since HEAD.** |
| `apps/web/src/App.tsx` | clean, mtime 16:55 | clean | **Untouched since HEAD.** |
| `apps/web/src/store.ts` | clean, mtime 16:55 | clean | **Untouched since HEAD.** |
| `apps/web/src/styles.css` | clean, 1699 ln | **`D` deleted, 0/1699** | **Deleted while I watched.** |

The four `.tsx`/`.ts` files are genuinely clean *as of 22:20:28*. That is a snapshot,
not a guarantee — the parallel agent moved into `main.tsx`, `layout.ts`,
`employeeCard.ts` and `index.html` in the final 90 seconds of the watch, so they are
clearly walking the web tree right now.

`styles.css` is the important one: it was pristine at baseline and is now **deleted**,
split into `index.css` + `app-surfaces.css` + `employee-card.css`. `main.tsx` currently
imports `./__verify-index.css`, a scratch file. Any patch written against `styles.css`
will not apply.

### Is the parallel work heading for the same per-employee multi-provider picker?

**Yes. It is not merely heading there — it has arrived, and it is building spec tickets
01 and 08 directly.** Overlap points:

- **`apps/daemon/src/seats.ts`** now contains `SeatTarget`, `SeatTargetOption`,
  `targets?: Record<string, SeatTarget>`, and
  `export const LEGACY_TARGET_ID = "opencode:default"`. That is verbatim the "Target
  shape" section of `spec.md:20-51`. Its comments even restate the spec's rationale
  ("would reject Codex's `gpt-5.6-sol` and Grok's `grok-build`", cf. `spec.md:13-14`).
  This is ticket **01-seat-target-contracts**.
- **`packages/protocol/src/entities.ts`** gained `linesAdded`, `linesRemoved`,
  `churnConfidence`. `spec.md:79-80` says "Code churn is new. No
  `linesAdded`/`linesRemoved` exists." It exists now. This is ticket
  **08-browser-thinking-churn**.
- **`packages/core/src/reduce.ts`** gained a `creditChurn` reducer with a tool-call-id
  idempotency ledger — the aggregation half of ticket 08.
- **`apps/web/src/api.ts`** already ships `SeatSpec`, `SeatsConfig`, `SeatDiagnosis`,
  `ModelInfo` (with `variants: efforts | none | unknown`), `getModels(probe)` and
  `getProviderStatus()`. That is the entire browser-side data layer for the picker.
- **`apps/web/src/settings/search.ts`** reserves `setting-seat-control` with keywords
  "model effort override agent".
- **`spec.md:80`** flags that `.diff-badge`/`.diff-add` are reused by `App.tsx:181` —
  and those selectors lived in the `styles.css` that just got deleted.

Net: tickets 01 and 08 should be treated as **already claimed and in progress**. Do not
open them.

---

## 4. Observed drift (22:09:44 → 22:20:28)

### Changed while I watched

| File | Baseline | Final | Trajectory |
| --- | --- | --- | --- |
| `apps/daemon/src/seats.ts` | clean | `+363/-17` | 0 → 32 → 104 → 155 → 177 → 267 → 363 insertions |
| `apps/daemon/test/seats.test.ts` | clean | `+392/-9` | appeared, then 363 → 392 |
| `packages/core/src/reduce.ts` | clean | `+280/-0` | 0 → 14 → 280 |
| `packages/core/test/reduce.test.ts` | clean | `+221/-0` | appeared mid-watch |
| `packages/protocol/src/entities.ts` | clean | `+33/-0` | appeared at 22:14:23 |
| `apps/daemon/src/providers.ts` | 20 ln | 73 ln | untracked, grew 20 → 73 |
| `apps/web/src/styles.css` | clean, 1699 ln | **`D` 0/1699** | deleted ~22:19 |
| `apps/web/src/main.tsx` | clean | `+1/-1` | import → `./__verify-index.css` |
| `apps/web/index.html` | clean | `+1/-2` | stylesheet ref + font preload |
| `apps/web/src/employeeCard.ts` | clean | `+1/-1` | comment retarget to `employee-card.css` |
| `apps/web/src/layout.ts` | clean | `+2/-2` | comment retarget to `app-surfaces.css` |
| `apps/web/test/layout.test.ts` | clean | `+3/-3` | follows `layout.ts` |
| `apps/web/src/app-surfaces.css` | absent | new | appeared 22:17:28 |
| `apps/web/src/__verify-index.css` | absent | new, then **deleted** | appeared ~22:19, gone by 22:22:15 |

### Late addendum (22:22:15, after the body of this report was written)

The scratch file resolved while I was writing. `apps/web/src/__verify-index.css` has
been deleted and `main.tsx` now reads `import "./index.css"` instead of the throwaway.
The three surviving stylesheets are `index.css`, `app-surfaces.css`,
`employee-card.css`. The `styles.css` → Tailwind v4 migration has therefore *landed*,
which means the author is free to move next — most likely back to the three missing
settings panels. Treat the web tree as hotter, not cooler, than the tables above imply.


### Stable across all 14 polls

`apps/daemon/src/config.ts` (36/5), `apps/daemon/src/index.ts` (4/1),
`apps/daemon/src/server.ts` (114/1), `apps/daemon/test/config-api.test.ts`,
`apps/daemon/src/models.ts`, `apps/web/package.json` (6/1),
`apps/web/src/api.ts` (127/0), `apps/web/src/settings/*`, `apps/web/src/ui/*`,
`apps/web/src/theme/*`, `apps/web/src/lib/*`, `apps/web/src/index.css`,
`apps/web/src/employee-card.css`, `packages/cli/src/models.ts` (12/580),
`packages/storage/src/store.ts` (6/1), `pnpm-lock.yaml` (375/15).

Note the settings island's mtimes are frozen at 21:44–21:52, before my watch began.
The agent finished that push, then pivoted to the daemon contracts at 21:52 and to the
CSS migration at 22:17. Stable-for-11-minutes is *not* the same as finished — the
missing `GeneralPanel.tsx`/`ProvidersPanel.tsx`/`AppearancePanel.tsx` prove they intend
to come back.

---

## 5. Verdict

### SAFE TO EDIT

- `apps/web/src/DetailPanel.tsx` — clean since HEAD, no mtime movement all watch; only file in the detail path nobody has opened.
- `apps/web/src/AgentNode.tsx` — clean since HEAD (mtime 16:53), untouched through 14 polls.
- `apps/web/src/Canvas.tsx` — clean since HEAD (mtime 08:58), never appeared in any status sample.
- `apps/web/src/WorkerCard.tsx` — clean since HEAD (mtime 08:49), outside every active path.
- `apps/web/src/EmployeeCardModal.tsx` — clean since HEAD (mtime 08:47), untouched.
- `apps/web/src/dismissLayer.ts` — clean since HEAD (mtime 08:47), untouched.
- `apps/daemon/src/models.ts` — untracked but mtime frozen at 21:21, stable across all polls; the catalogue move has settled.
- `apps/daemon/test/config-api.test.ts` — mtime frozen at 21:32, stable; config API tests are done.
- `.scratch/multi-provider-seats/**` — our own planning surface, not touched by the other agent.

Caveat on all of the above: safe **as of 22:20:28**, and `App.tsx`/`store.ts` are
deliberately excluded even though they are technically clean — see below.

### DO NOT TOUCH, ACTIVE PARALLEL WORK

- `apps/daemon/src/seats.ts` — grew 0→363 insertions across five polls; this is spec ticket 01 being written live.
- `apps/daemon/test/seats.test.ts` — appeared mid-watch and still moving (363→392).
- `apps/daemon/src/providers.ts` — untracked and grew 20→73 lines during the watch.
- `packages/protocol/src/entities.ts` — gained `linesAdded`/`linesRemoved`/`churnConfidence` at 22:14; ticket 08's contract.
- `packages/core/src/reduce.ts` — `creditChurn` reducer went 0→280 insertions in one watch.
- `packages/core/test/reduce.test.ts` — appeared mid-watch at +221.
- `apps/web/src/styles.css` — **deleted during the watch**; any patch against it will not apply.
- `apps/web/src/app-surfaces.css` — created at 22:17:28, receiving the canvas rules from `styles.css`.
- `apps/web/src/__verify-index.css` — throwaway scratch file `main.tsx` imports right now; will vanish.
- `apps/web/src/index.css` — the Tailwind v4 entrypoint the migration is converging on.
- `apps/web/src/employee-card.css` — the other half of the `styles.css` split.
- `apps/web/src/main.tsx` — rewritten at 22:18:29, currently pointing at the scratch CSS.
- `apps/web/index.html` — rewritten at 22:19 as part of the same CSS migration.
- `apps/web/src/layout.ts` — rewritten at 22:18:42; its `NODE_WIDTH` comments track the CSS split.
- `apps/web/test/layout.test.ts` — moves in lockstep with `layout.ts`.
- `apps/web/src/employeeCard.ts` — rewritten at 22:18:50 in the same sweep.
- `apps/web/src/settings/SettingsPage.tsx` — imports three panels that do not exist; the author is mid-feature.
- `apps/web/src/settings/GeneralPanel.tsx` — **must be created by the parallel agent**; owns the Employees and Seat control rows.
- `apps/web/src/settings/ProvidersPanel.tsx` — same: imported, absent, theirs to write.
- `apps/web/src/settings/AppearancePanel.tsx` — same: imported, absent, theirs to write.
- `apps/web/src/settings/search.ts` — index ids must land with the panels; edit it and you desync their search.
- `apps/web/src/settings/useConfig.ts` — the shared config store the unwritten panels will consume.
- `apps/web/src/ui/primitives.tsx` — 829-line design system the panels are being built against; churn here breaks all three at once.
- `apps/web/src/theme/*.ts` — five files landed 21:44–21:48 as one unit; treat the whole directory as theirs.
- `apps/web/src/lib/utils.ts` — the `cn()` helper every new component imports.
- `apps/web/src/api.ts` — already carries the exact seat/model/provider types our picker needs; they will edit it next for `targets`.
- `apps/web/package.json` / `pnpm-lock.yaml` — mid Tailwind v4 dependency migration.
- `apps/daemon/src/config.ts` — `ConfigPatchSchema` is `.strict()` and must change in lockstep with `seats.ts`.
- `apps/daemon/src/server.ts` — serves `/v1/config`, `/v1/models`, `/v1/providers/status` against schemas being rewritten now.
- `apps/web/src/App.tsx` — clean, but `.diff-badge`/`.diff-add` at l.181-182 are defined in the just-deleted `styles.css` and are ticket 08's target; collision is near-certain.
- `apps/web/src/store.ts` — clean, but it must absorb `linesAdded`/`linesRemoved` from the protocol change landing right now.

### Honest uncertainty

- `App.tsx` and `store.ts` are **clean on disk** and I could defend calling them safe.
  I put them in the do-not-touch list on blast radius, not on evidence of edit: ticket
  08 cannot land without them, and the agent was three files away at 22:18:50. If you
  need them, re-check `git status` first and coordinate.
- The settings island (`settings/`, `ui/`, `theme/`, `lib/`) did not move once during
  my 11 minutes. I cannot tell from mtimes alone whether the author has parked it for
  good or is looping back after the CSS migration. The three missing panel imports are
  strong evidence for "looping back", so I ruled it unsafe. This is inference, not
  observation.
- I never saw the other agent's process or prompt. Everything here is inferred from
  filesystem and git state.
- This report ages badly. Re-run `git status --short` before acting on it.
