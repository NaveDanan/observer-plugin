# Release abandoned subagent admissions

Status: ready-for-agent

Failed native task creation and failed nested `agent_spawn` leave durable `starting` assignments.
Those rows count toward the 15-subagent lifetime limit. Add an explicit abort/delete transition or
make never-bound admissions stop consuming the lifetime allowance.

Acceptance: tests show repeated failed creations do not block a later valid subagent.
