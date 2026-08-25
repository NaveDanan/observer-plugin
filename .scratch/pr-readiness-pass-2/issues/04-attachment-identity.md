# Scope Copilot attachment identity

Status: ready-for-agent

Copilot attachment IDs hash only the filesystem path, while `message_attachments.id` is global.
The same file attached in two messages or sessions must retain two valid transcript references and
must survive pruning of either owner as appropriate.

Acceptance: a storage or daemon test reuses one path across sessions, prunes one session, and still
serves or resolves the surviving attachment.
