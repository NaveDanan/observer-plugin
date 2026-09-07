# Employee execution contracts

Implement the user's request to redefine Observer employees for effective
task selection and collaboration. All work in this change is performed by the
root agent without subagents.

Keep the 14 stable identities and existing user model/skill settings. Add
specialty contracts, explicit work stages, bounded assignment and result formats,
ownership rules, evidence requirements, and capability discovery. Render them
across all supported hosts. Supply a portable employee-brief tool and an optional
browser-tool configuration without claiming unavailable tools are installed.

Acceptance criteria:

- Every employee has a mission, selection criteria, default stage, workflow,
  deliverables, completion evidence, boundaries, valid handoffs, and capabilities.
- The assigned stage overrides the default. Review/verify preserve product code
  unless the task authorizes a repair.
- Guidance respects requests to work alone, host limits, existing edits, and
  shared browser/desktop ownership.
- Generated host definitions, API results, and tool responses use the contracts.
- Configured skills still apply without asserting installation. Model pins,
  ownership markers, and user configuration remain compatible.
- Automated checks and primary-source design notes document what was verified
  and distinguish wiring checks from empirical LLM performance evaluation.

## Completion evidence

Implemented all acceptance criteria without spawning subagents. Existing
uncommitted workspace changes were preserved.

- Library compilation and web typechecking passed; Vite production build passed.
- Full suite exercised 1,441 tests. Two test-only failures were corrected and
  both affected suites passed on rerun, covering 208 tests. Five additional
  routing cases then passed with the matcher suite, for 1,446 passing unique
  test cases across the full run and targeted reruns.
- `git diff --check` passed.
- Built `release/observer-ai-0.9.20-employee-contracts.tgz`. This preview archive
  contains the current working tree, including changes that predated this task.
- Packaged MCP smoke passed against a real local test daemon: tool discovery,
  the 14-employee index, explicit review mode, invalid-mode error handling, and
  the included optional Playwright configuration. The temporary test daemon
  was closed and its temporary configuration removed.
- The installed global plugin and running host sessions were not replaced.
  Browser integration is an optional configuration, not an installed service.
  No empirical LLM performance claim is made from these automated checks.
