---
title: Repair shared command contracts required by MediaWell
created: 2026-10-23
status: in-progress
register: FOR AGENTS
---

# MediaWell command contract repairs

- Derived from Astra review of MediaWell be3f762..3057f3a: source keyboard policy, reserved-command rebinding, native menu ordering and exact verified Electron compatibility.
- Scope: commands implementation/tests and settings-electron compatibility metadata; affected release versions/manifest and directly related contract documentation.
- Existing immutable releases remain unchanged. Generate new versioned packages through repository release tooling; no npm or public GitHub Release publication.
- Own repository only. Another Sol builder is working in the separate MediaWell repository; do not change it from this task.
- Parent will inspect/commit these changes and have MediaWell consume the corrected immutable artefacts during its shell repair slice, then request Astra re-review.
