# Keep failure receipts in patch cards

Status: ready-for-agent

`PatchStep` renders changed files but hides error, output, metadata, and footer data. A failed patch
must show the diagnostic and visibly report failure without losing the compact changed-file view.

Acceptance: a component-level or correct rendering-seam test proves a failed patch exposes its
captured error/output and failure status.
