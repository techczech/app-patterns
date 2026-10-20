# ADR-0001: Apps consume versioned vendored tarballs

Status: accepted, 2026-10-20.

## Context

Live package folder dependencies can leave apps using stale builds, collide in Bun lockfiles and omit built output on another machine.

Origin: Bridle ADR-0033, extracted 2026-10-20 at Bridle `f295550`.

## Decision

Build packages in dependency order from clean `dist/` directories. Pack each package as `app-patterns-<name>-<version>.tgz` and record its integrity and content digest in `releases/manifest.json`. A released version is immutable: different contents require a new version.

Apps vendor the tarballs under `vendor/app-patterns/`, use `file:` tarball dependencies and map all required sibling packages in root overrides. Siblings are peer dependencies with explicit compatible semver ranges. The vendor tool checks those ranges and verifies the manifest against each archive. It defaults to a dry run and never installs dependencies or changes Git state in an app.

Tarballs contain built output, package metadata, README and licence files. Reject source folders, tests, source maps embedding source content, macOS home paths and Windows home paths. Refuse symlinks and paths outside the app. Remove an obsolete vendored tarball only when its ownership ledger and the release manifest both prove its bytes.

## Consequences

Apps commit their tarballs, dependency manifests and lockfile together. This applies to public apps too: App Patterns Framework is MIT licensed. Registry publication is optional and is not required to consume these packages. Release tarballs are ignored in this repository; its release manifest is tracked.
