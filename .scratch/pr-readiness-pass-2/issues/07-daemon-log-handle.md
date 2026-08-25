# Close the parent daemon log handle

Status: ready-for-agent

OpenCode autostart opens `daemon.log` for child stdio but the long-lived parent plugin never closes
its copy. Close it on successful and failed spawn paths without invalidating the child's inherited
descriptors.

Acceptance: a unit test proves one close per opened descriptor across success and synchronous
failure paths.
