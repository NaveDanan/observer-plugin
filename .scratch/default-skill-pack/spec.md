# Default employee skills pack

`observer config` lists every enabled skill Codex reports for the current
project, with project and global entries identified. **Pass All Skills** is on
by default. While it is on, every Codex subagent receives the merged inventory,
whether it uses an Observer employee agent or a default subcontractor. The
inventory must follow Codex's collision, enablement, plugin, and admin rules.

The pack carries progressive-disclosure metadata, not the full contents of
every skill: name, description, scope, and absolute `SKILL.md` path. Subagent
instructions tell the model to read the selected `SKILL.md` completely before
acting. A missing or incompatible Codex installation leaves the pack empty and
produces a warning without blocking delegation.
