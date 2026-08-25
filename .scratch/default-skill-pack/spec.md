# Default employee skills pack

Observer-generated Codex employees receive a Default skills pack containing
every enabled skill Codex reports for the current project. The inventory must
include both project and global skills and must follow Codex's own collision,
enablement, plugin, and admin rules.

The pack carries progressive-disclosure metadata, not the full contents of
every skill: name, description, scope, and absolute `SKILL.md` path. Employee
instructions tell the model to read the selected `SKILL.md` completely before
acting. A missing or incompatible Codex installation leaves the pack empty and
produces a warning without blocking employee generation.
