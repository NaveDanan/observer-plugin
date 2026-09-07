# Focused employee roster

Status: ready-for-human

Replace the fourteen-role roster with six default specialties and two optional
specialists. Use familiar Israeli names and show role before name. Work alone.

Default: Frontend Engineer, Backend Engineer, Product Designer, Quality Engineer,
Platform Engineer, Research & Data Analyst. Optional: Security Specialist and
Hardware Specialist. Root guidance owns requirements, architecture, ownership,
capacity assumptions, and dependency sequencing. Preserve the seven work modes.

Use stable role IDs independent of display names. Resolve surviving and merged
legacy IDs for saved settings and observed history. Preserve retired management
settings with an explanatory diagnostic. Enable specialists explicitly, independently
of model pin control. Reconcile owned definitions across all four hosts, preserve
user-owned files, and test default/optional selection and configuration round trips.

Existing working-tree changes remain in place. This task updates repository and
preview outputs; it does not change the installed plugin or use subagents.

## Implementation

Implemented six default roles and two explicitly enabled specialists. Roles use
stable IDs and Israeli display names. Root guidance includes requirements,
architecture, capacity, ownership, dependencies, and integration. Both settings
interfaces support specialist enablement, and generated host definitions and
matching honor it independently of model pins. Legacy settings use documented
precedence and remain preserved. Printable roster data keeps its existing schema.

Browser validation exposed an existing startup race on direct settings links.
Protected API requests now share bootstrap initialization before sending requests;
failure propagates and later attempts can retry. This is covered by two tests.

## Validation

- Full Vitest run passed 1,458 tests. The later startup fix passed all 420 web
  tests, including two new cases; the final terminal change passed all 148 CLI
  configuration tests. This covers 1,460 distinct passing cases across the runs.
- TypeScript checks passed for roster, daemon, CLI, and web. The production web
  build passed with the existing large-chunk advisory.
- Browser checks used an isolated in-memory daemon and temporary configuration.
  Verified role-first names, optional badges, enablement, persisted state after
  reload, and disabled-specialist copy. The reload race was reproduced and fixed.
  The temporary browser tab and server were closed afterward.
- The UI detector reported no findings for changed roster/dialog/node components.
- `git diff --check` passed.
- Built `release/observer-ai-0.9.20-focused-roster.tgz`, 26,917,671 bytes. The
  packaged MCP smoke passed tool discovery, six default employees, a legacy-ID
  review brief, invalid-mode errors, and optional browser configuration.
- Existing working-tree changes are included in the preview. No global plugin
  installation, commits, or subagents were used.

## Release validation

The user authorized committing, pushing, publishing, and installing this work on
all supported hosts. Release v0.9.21 passed the complete production build and all
1,460 tests in one run. Its packaged MCP smoke passed employee discovery, legacy
ID resolution, stage selection, invalid-stage handling, and browser configuration.
The release keeps six default employees and preserves saved specialist settings.
