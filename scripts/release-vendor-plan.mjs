// Pure planning for release:vendor: which App Patterns Framework tarballs an app needs, how its
// package.json files change, and which previously vendored tarballs may go.
// Requires Bun for Bun.semver.
// No file system access here; release-vendor.mjs supplies verified inputs.

import { posix } from "node:path";

import { assertNoDuplicateKeys, parseJsonWithSpans, setSectionString } from "./release-json-edit.mjs";

export const VENDOR_DIR = "vendor/app-patterns";
export const LEDGER_FILE = "vendored.json";
export const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
export const OVERRIDE_SECTIONS = ["overrides", "resolutions"];
const FRAMEWORK = "@app-patterns/";
const VENDORED_TARBALL = /^app-patterns-.+\.tgz$/;
// app-patterns-<unscoped name>-<semver>.tgz, a plain file name with no path separators.
const RELEASE_TARBALL = /^app-patterns-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/;

const isFramework = (name) => name.startsWith(FRAMEWORK);

// Accept only explicit semver versions and comparator sets. Bun's matcher is
// permissive about tags, protocols and malformed alternatives, so guard it.
const VERSION_NUMBER = String.raw`(?:0|[1-9]\d*)`;
const PRERELEASE_ID = String.raw`(?:${VERSION_NUMBER}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const PLAIN_VERSION = String.raw`${VERSION_NUMBER}\.${VERSION_NUMBER}\.${VERSION_NUMBER}(?:-${PRERELEASE_ID}(?:\.${PRERELEASE_ID})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const PLAIN_COMPARATOR = String.raw`(?:\^|~|>=?|<=?|=)?\s*${PLAIN_VERSION}`;
const PLAIN_COMPARATOR_SET = new RegExp(String.raw`^${PLAIN_COMPARATOR}(?:\s+${PLAIN_COMPARATOR})*$`);

function isPlainPeerRange(range) {
  return typeof range === "string" && range.split("||").every((set) => PLAIN_COMPARATOR_SET.test(set.trim()));
}

/** The only tarball file name a release of `name`@`version` may have. */
export function expectedTarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/** Throws unless `file` is a plain release tarball name (and, given name/version, the expected one). */
export function assertTarballName(file, name, version) {
  const valid = typeof file === "string" && RELEASE_TARBALL.test(file) && !file.includes("/") && !file.includes("\\");
  if (!valid || (name && file !== expectedTarballName(name, version))) {
    throw new Error(
      `${JSON.stringify(file)} is not a valid release tarball name` +
        (name ? ` for ${name} ${version} (expected ${expectedTarballName(name, version)})` : ""),
    );
  }
  return file;
}

/**
 * All @app-patterns/* packages reachable from `names` through the App Patterns Framework peers each
 * release declares. `releaseOf(name)` returns { needs: { name: range } } and
 * throws for unknown packages.
 */
export function frameworkClosure(names, releaseOf) {
  const seen = new Set();
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const release = releaseOf(name);
    seen.add(name);
    queue.push(...Object.keys(release.needs ?? {}));
  }
  return [...seen].sort();
}

/** The `file:` spec for a vendored tarball, relative to the package.json at relPath. */
export function tarballSpec(packageJsonRelPath, file) {
  const fromDir = posix.dirname(packageJsonRelPath.split("\\").join("/"));
  let path = posix.relative(fromDir, `${VENDOR_DIR}/${file}`);
  if (!path.startsWith("../")) path = `./${path}`;
  return `file:${path}`;
}

function frameworkNames(object) {
  return Object.keys(object ?? {}).filter(isFramework);
}

/** Workspace directories a root `workspaces` field names, as app-relative paths. Rejects paths leaving the app. */
export function workspacePatterns(rootJson) {
  const patterns = Array.isArray(rootJson.workspaces) ? rootJson.workspaces : (rootJson.workspaces?.packages ?? []);
  return patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map((pattern) => {
      const clean = pattern.replace(/\/+$/, "");
      if (clean.startsWith("/") || clean.split("/").includes("..")) {
        throw new Error(`Workspace ${JSON.stringify(pattern)} points outside the app; release:vendor only edits files inside it.`);
      }
      return clean;
    });
}

/** Parses vendor/app-patterns/vendored.json text (or null) into { files: { file: { name, version, integrity } } }. */
export function parseLedger(text) {
  if (text === null || text === undefined) return { schema: 1, files: {} };
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch (error) {
    throw new Error(`${VENDOR_DIR}/${LEDGER_FILE} is not valid JSON: ${error.message}`);
  }
  if (!ledger || ledger.schema !== 1 || typeof ledger.files !== "object" || ledger.files === null) {
    throw new Error(`${VENDOR_DIR}/${LEDGER_FILE} is not a release:vendor ledger (schema 1 with "files").`);
  }
  for (const [file, entry] of Object.entries(ledger.files)) {
    assertTarballName(file);
    if (typeof entry?.integrity !== "string") throw new Error(`${VENDOR_DIR}/${LEDGER_FILE}: ${file} has no integrity`);
  }
  return ledger;
}

export function formatLedger(files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ schema: 1, files: sorted }, null, 2)}\n`;
}

/**
 * Plans the change. Inputs:
 *   packageJsons: [{ relPath, text }], root first, relPath relative to the app root;
 *   releaseOf(name): a verified release { name, version, file, integrity, contentsDigest, needs };
 *   ledger: parsed vendored.json; existingVendorFiles: names currently in vendor/app-patterns.
 * Output: { needed, files: [{ relPath, before, after, addedPeers }], tarballs,
 *   ledgerRemovals: [{ file, integrity }], unowned: [file] }.
 */
export function planVendor({ packageJsons, releaseOf, ledger = { schema: 1, files: {} }, existingVendorFiles = [] }) {
  if (!packageJsons.length) throw new Error("planVendor needs at least the root package.json");
  const sections = [...DEPENDENCY_SECTIONS, ...OVERRIDE_SECTIONS];
  const parsed = packageJsons.map(({ relPath, text }) => {
    assertNoDuplicateKeys(text, sections, relPath);
    return { relPath, text, json: JSON.parse(text) };
  });

  const seeds = new Set();
  for (const { json } of parsed) {
    for (const section of sections) for (const name of frameworkNames(json[section])) seeds.add(name);
  }
  const needed = frameworkClosure(seeds, releaseOf);
  // Check the complete closure before planning any app edits, including in
  // dry runs. Bun's built-in matcher handles semver without a new dependency.
  for (const name of needed) {
    const release = releaseOf(name);
    for (const [peer, range] of Object.entries(release.needs ?? {})) {
      if (!isPlainPeerRange(range)) {
        throw new Error(
          `${name} ${release.version} has invalid ${peer} peer range ${JSON.stringify(range)}; ` +
            "expected plain semver versions and comparators, joined by spaces or ||.",
        );
      }
      const selected = releaseOf(peer);
      if (!Bun.semver.satisfies(selected.version, range)) {
        throw new Error(
          `${name} ${release.version} requires ${peer} ${range}, but the selected release is ${selected.version}. ` +
            "Release compatible packages before vendoring.",
        );
      }
    }
  }
  const fileOf = (name) => releaseOf(name).file;

  const files = [];
  parsed.forEach(({ relPath, text, json }, index) => {
    let next = text;
    const declared = new Set(DEPENDENCY_SECTIONS.flatMap((section) => frameworkNames(json[section])));
    const added = [];

    for (const section of DEPENDENCY_SECTIONS) {
      // peerDependencies keep their ranges: a peer entry never installs anything.
      if (section === "peerDependencies") continue;
      const names = frameworkNames(json[section]);
      if (!names.length) continue;
      for (const name of names) next = setSectionString(next, section, name, tarballSpec(relPath, fileOf(name)));
      for (const name of frameworkClosure(names, releaseOf)) {
        if (declared.has(name)) continue;
        declared.add(name);
        added.push(name);
        next = setSectionString(next, section, name, tarballSpec(relPath, fileOf(name)));
      }
    }
    for (const section of OVERRIDE_SECTIONS) {
      for (const name of frameworkNames(json[section])) {
        next = setSectionString(next, section, name, tarballSpec(relPath, fileOf(name)));
      }
    }
    if (index === 0) {
      const overrideSection = json.overrides || !json.resolutions ? "overrides" : "resolutions";
      for (const name of needed) next = setSectionString(next, overrideSection, name, tarballSpec(relPath, fileOf(name)));
    }
    parseJsonWithSpans(next);
    if (next !== text) files.push({ relPath, before: text, after: next, addedPeers: added });
  });

  const tarballs = needed.map((name) => {
    const release = releaseOf(name);
    return {
      name,
      version: release.version,
      file: assertTarballName(release.file, name, release.version),
      integrity: release.integrity,
      contentsDigest: release.contentsDigest,
    };
  });
  const wanted = new Set(tarballs.map((t) => t.file));
  const ledgerRemovals = Object.entries(ledger.files)
    .filter(([file]) => !wanted.has(file))
    .map(([file, entry]) => ({ file: assertTarballName(file), integrity: entry.integrity }))
    .sort((a, b) => (a.file < b.file ? -1 : 1));
  const unowned = existingVendorFiles
    .filter((file) => VENDORED_TARBALL.test(file) && !wanted.has(file) && !ledger.files[file])
    .sort();
  return { needed, files, tarballs, ledgerRemovals, unowned };
}
