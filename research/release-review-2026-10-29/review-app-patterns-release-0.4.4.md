---
title: Independent bounded review of App Patterns collection 0.4.4
date: 2026-10-29
reviewer: Codex gpt-6.1-sol
verdict: changes-required
scope: Prepared local candidate; production read-only
---

# App Patterns release review

**Changes required.** Archive integrity and compiled-byte preservation pass. Correct the documented licence handoff to consuming apps and finalise the public release body before publication. No archive replacement or package version bump is needed.

## Findings and smallest corrections

### 1. Required: carry the licence through the documented installation path

The two unchanged archives, app-patterns-updates-0.4.1.tgz and app-patterns-updates-react-0.4.1.tgz, contain no LICENSE. Both declare MIT. Root LICENSE includes Dominik Lukeš's copyright and the notice-inclusion condition at lines 10–11. Five other candidate archives include LICENSE.

The release document's Package inventory section proposes shipping root LICENSE separately and retaining it when vendoring. That is a workable distribution arrangement if followed. It is not implemented by release:vendor: scripts/release-vendor-plan.mjs planVendor returns only tarballs; scripts/release-vendor.mjs:280–285 loads that plan, and :384–396 writes tarballs and vendored.json. No licence-copy operation exists. An in-memory plan using the actual release loader with only updates-react declared selects exactly updates and updates-react; neither brings another archive's licence along. The all-seven plan also succeeds. This is a concrete gap in the normal consumption path, independent of the pre-existing package omission.

README.md:40–42 and docs/index.md:28–32 tell users to download archives and manifest, vendor, install and commit, without copying the licence. Following those instructions does not retain the separate notice. Uploading a root LICENSE asset alone does not close that gap.

Smallest correction: retain the exact immutable tarballs and existing vendor implementation. Add an explicit step to README installation and the Pages installation list: copy the matching release's LICENSE (or identical tagged checkout root LICENSE) to the consuming app's vendor/app-patterns/LICENSE after vendoring; commit it with the vendor folder and include the notice in the app's shipped third-party notices. State clearly that release:vendor does not copy it automatically. The source checkout copy avoids needing an additional licence download. No production write-path change is necessary. Verify this manual path with an updates-react-only consumer; both tarballs must remain byte-identical and the copied notice must match root LICENSE.

Classification: the legacy tarball omission is a distribution limitation, not an archive-integrity failure or a reason to rewrite 0.4.1. The incomplete normal installation instructions are a release-readiness blocker for the prepared candidate. This finding applies the repository's own notice text; it makes no broader legal or security assessment.

### 2. Required routine finalisation: separate public release body from preparation procedure

The proposed gh command uses docs/release-app-patterns-0.4.4.md wholesale as --notes-file. Its frontmatter says “release candidate” and “prepared-unpublished”; the opening says publication requires the parent review. It also includes the entire Parent publication procedure, command and internal preparation context. CHANGELOG.md:3 says “prepared, unpublished”. Finalise public wording at publication, and supply only the public release description, changes, inventory and installation/licence guidance as release notes. Keep the operational procedure in repository documentation. Do not retrospectively change manifest commitDirty provenance.

The release document's relative installation link, ../README.md#install-with-vendored-tarballs, works as a repository document but is unsuitable when reused as GitHub release-body Markdown. Use an absolute repository README URL, preferably pinned to v0.4.4, in the public body.

## Independently verified evidence

Baseline HEAD was dff2798c8a50c6a40f7bf94459cb3ee2713a53d3. Reviewed git diff plus the untracked Pages/release documents and preparation receipt. Production changes are the three package version fields, their three bun.lock workspace versions, README/CHANGELOG and release manifest. No source implementation edits appear in the candidate diff. research/_manifest.jsonl is concurrent preparation evidence and was left untouched.

Inline Python tarfile/hashlib inspection exited 0. It independently recomputed SHA-512 SRI, the manifest's sorted-path/file-hash content digest, and packed package name/version for all seven current archives. All matched. It checked every SHA256SUMS entry: seven archives, manifest and root LICENSE all matched. Manifest SHA-256 is bca2d47f1137e72749bedba52938e49f9f86f29419675a0fdd0dc698ad9d5748. All 24 historical released records from HEAD are preserved exactly.

Direct archive member-byte comparisons found:

- Commands 0.4.2 to 0.4.3 changes only README.md and package.json; all seven dist files are identical.
- Settings React 0.4.2 to 0.4.3 changes only package.json; all 35 dist files are identical.
- Settings Electron 0.4.3 to 0.4.4 changes only package.json; all 14 dist files are identical.

The SHA256SUMS LICENSE entry names a flat release asset. In the checkout its source is root LICENSE, while the other eight inputs are under releases/. A flat downloaded-asset directory is the appropriate context for a standard checksum command; running it unchanged inside checkout releases/ lacks LICENSE. This is a layout detail to explain, not a checksum mismatch.

A focused Bun invocation imported createReleaseLoader and planVendor, with in-memory package manifests for updates-react alone and for all seven packages. Both exited 0 and produced compatible peer closure, relative file dependency paths and root overrides. No consumer filesystem, Git repository, installation or write mode was used.

The existing sequential check-final.log contains 73 + 109 + 184 + 21 + 6 + 124 + 80 + 108 = 805 passing tests and zero failures. This is inherited builder evidence, not an independent rerun. No repeated matrix was justified by the documentation/metadata candidate. git diff --check exited 0 independently.

## Pages and installation scope

Static inspection finds docs/index.md has valid frontmatter and default layout. docs/_config.yml uses Cayman, url https://techczech.github.io and baseurl /app-patterns, consistent with the planned main /docs project Pages configuration. All seven package destinations correspond to existing local package README files or the outline directory; the README and keyboard-safety anchors correspond to local headings. Absolute GitHub destinations avoid a project-baseurl mismatch. No Pages deployment workflow is needed for the documented branch-source deployment.

The source-tag plus matching seven archives and manifest route is coherent. The vendor planner accepts the exact collection and sibling peer ranges. The README's source-build instructions remain separate from the prebuilt-release download route. Installation requires the licence step described above.

No live link, remote repository state, Pages rendering/build/deployment, published download, installed app or publication acceptance was verified. Public MIT/latest v0.4.1/Pages-disabled state is inherited from the preparation receipt and archived GitHub responses, not refreshed here. Parent retains publication and website/catalogue work.

## Boundaries and handoff

No agents, production edits, version changes, Git writes, commits, pushes, tags or deployment occurred. Only this new review evidence was written. No scratch files were created. The verdict applies to these observed bytes; parent should recheck changed documentation and the focused manual licence handoff after correction. No user product decision is needed for these technical corrections.
