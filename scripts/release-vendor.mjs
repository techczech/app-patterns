#!/usr/bin/env bun
// bun run release:vendor <appRoot> [--write] [--from <releasesDir>]
//
// Points an app at App Patterns Framework release tarballs (ADR-0001). Reads the app's
// package.json and its workspace package.json files, collects every @app-patterns/*
// name they mention plus the @app-patterns peers those packages need (read from the
// verified tarballs themselves), then:
//   - copies the matching tarballs into <appRoot>/vendor/app-patterns/;
//   - rewrites each @app-patterns dependency and override to file:<path to tarball>;
//   - adds missing @app-patterns peers to the section that needs them and to the
//     root `overrides`;
//   - records what it placed in vendor/app-patterns/vendored.json, and deletes a
//     tarball it placed earlier only if the app no longer uses it, its bytes
//     are unchanged and they are byte-identical to a release in App Patterns Framework's own
//     manifest (`released`), so a deleted file can always be regenerated.
// Dry run unless --write. Never runs install or git commands that change the app.
// Refuses symlinks and any path that resolves outside the app. Every write goes
// to a fresh temp file created exclusively next to its destination and is then
// renamed over it: a rename replaces a symlink itself, never its target.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { lineDiff } from "./release-json-edit.mjs";
import { loadManifest } from "./release-pack.mjs";
import {
  LEDGER_FILE,
  VENDOR_DIR,
  assertTarballName,
  formatLedger,
  parseLedger,
  planVendor,
  workspacePatterns,
} from "./release-vendor-plan.mjs";
import { contentsDigest, integrity, readTarEntries, tarballManifest } from "./release-tarball.mjs";

export {
  DEPENDENCY_SECTIONS,
  VENDOR_DIR,
  frameworkClosure,
  planVendor,
  tarballSpec,
} from "./release-vendor-plan.mjs";

const FRAMEWORK = "@app-patterns/";

function frameworkEntries(object) {
  return Object.fromEntries(
    Object.entries(object ?? {})
      .filter(([name]) => name.startsWith(FRAMEWORK))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

function sameRecord(a, b) {
  return JSON.stringify(frameworkEntries(a)) === JSON.stringify(frameworkEntries(b));
}

/**
 * Returns releaseOf(name): reads releases/<file>, checks its integrity and
 * contents digest against the manifest, and takes the package's App Patterns Framework peers
 * from the package.json inside the archive. Refuses when the manifest's
 * frameworkPeers disagree with the archive.
 */
export function createReleaseLoader(releasesDir, manifest) {
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const record = manifest.packages?.[name];
    if (!record) throw new Error(`${name} is not in the release manifest. Run release:pack in App Patterns Framework first.`);
    const file = assertTarballName(record.file, name, record.version);
    const source = join(releasesDir, file);
    if (dirname(source) !== releasesDir) throw new Error(`${file} resolves outside ${releasesDir}`);
    if (!existsSync(source)) throw new Error(`${file} is missing from ${releasesDir}`);
    if (lstatSync(source).isSymbolicLink()) throw new Error(`${source} is a symlink; release tarballs must be plain files.`);
    const bytes = readFileSync(source);
    if (integrity(bytes) !== record.integrity) {
      throw new Error(`${source} does not match the integrity in manifest.json; repack it.`);
    }
    const entries = readTarEntries(bytes);
    const digest = contentsDigest(entries);
    if (digest !== record.contentsDigest) {
      throw new Error(`${source} does not match the contentsDigest in manifest.json; repack it.`);
    }
    const archived = tarballManifest(entries);
    if (archived.name !== name || archived.version !== record.version) {
      throw new Error(`${file} contains ${archived.name} ${archived.version}, not ${name} ${record.version}.`);
    }
    const hardFrameworkDeps = Object.keys(frameworkEntries(archived.dependencies));
    if (hardFrameworkDeps.length) {
      throw new Error(`${file} declares ${hardFrameworkDeps.join(", ")} as dependencies; App Patterns Framework packages declare siblings as peers.`);
    }
    const needs = frameworkEntries(archived.peerDependencies);
    if (!sameRecord(needs, record.frameworkPeers)) {
      throw new Error(
        `manifest.json frameworkPeers for ${name} ${JSON.stringify(frameworkEntries(record.frameworkPeers))} does not match its archive ${JSON.stringify(needs)}.`,
      );
    }
    const release = { name, version: record.version, file, integrity: record.integrity, contentsDigest: digest, needs, bytes };
    cache.set(name, release);
    return release;
  };
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/** Throws if relPath (inside appRoot) is a symlink or resolves outside the app. Returns whether it exists. */
function assertPlainInside(appRoot, relPath, what) {
  const abs = join(appRoot, relPath);
  if (!isInside(appRoot, abs)) throw new Error(`${what} ${relPath} is outside the app.`);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    // Absent: its nearest existing parent must still resolve inside the app.
    let parent = dirname(abs);
    while (!existsSync(parent)) parent = dirname(parent);
    if (!isInside(appRoot, realpathSync(parent))) throw new Error(`${what} ${relPath} resolves outside the app.`);
    return false;
  }
  if (stat.isSymbolicLink()) throw new Error(`${what} ${relPath} is a symlink; release:vendor refuses to write through symlinks.`);
  if (!isInside(appRoot, realpathSync(abs))) throw new Error(`${what} ${relPath} resolves outside the app.`);
  return true;
}

/** Workspace package.json paths (app-relative), each checked to be a plain file inside the app. */
function discoverWorkspaces(appRoot, rootJson) {
  const found = new Set();
  const warnings = [];
  for (const pattern of workspacePatterns(rootJson)) {
    let dirs = [];
    if (!pattern.includes("*")) {
      dirs = [pattern];
    } else if (/^[^*]+\/\*$/.test(pattern)) {
      const parent = pattern.slice(0, -2);
      if (assertPlainInside(appRoot, parent, "Workspace folder")) {
        dirs = readdirSync(join(appRoot, parent), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => `${parent}/${entry.name}`);
      }
    } else {
      warnings.push(`workspace pattern ${pattern} is not supported; pass that package's folder separately`);
    }
    for (const dir of dirs) {
      const relPath = posix.join(dir, "package.json");
      if (!existsSync(join(appRoot, relPath))) continue;
      assertPlainInside(appRoot, dir, "Workspace folder");
      assertPlainInside(appRoot, relPath, "Workspace package.json");
      found.add(relPath);
    }
  }
  return { paths: [...found].sort(), warnings };
}

/**
 * Makes relPath (inside appRoot) a real directory, creating it if absent, and
 * refuses if it is (or has become) a symlink or resolves outside the app.
 * Creates one level only; the parent must already have passed this check.
 */
function ensurePlainDir(appRoot, relPath) {
  const abs = join(appRoot, relPath);
  if (!existsSync(abs) && !lstatSafe(abs)) mkdirSync(abs);
  const stat = lstatSafe(abs);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${relPath} in the app is not a plain folder (a symlink?); release:vendor wrote nothing further.`);
  }
  if (realpathSync(abs) !== abs) throw new Error(`${relPath} resolves outside the app; release:vendor wrote nothing further.`);
  return abs;
}

function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Writes bytes to `dir/name` without following a symlink at the destination:
 * a fresh temp file is created exclusively (O_CREAT|O_EXCL) in `dir`, then
 * renamed onto the destination.
 */
function writeReplacing(dir, name, bytes) {
  const dest = join(dir, name);
  if (dirname(dest) !== dir) throw new Error(`${name} would be written outside ${dir}`);
  const temp = join(dir, `.release-vendor-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o644);
  try {
    const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    closeSync(fd);
    renameSync(temp, dest);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
}

function gitStatus(appRoot, paths) {
  const result = spawnSync("git", ["-C", appRoot, "status", "--porcelain", "--untracked-files=all", "--", ...paths], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Cannot check git status in ${appRoot} (is it a git repository?): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function parseArgs(argv) {
  const options = { appRoot: null, write: false, from: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--from") options.from = argv[++index];
    else if (arg.startsWith("--from=")) options.from = arg.slice("--from=".length);
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (options.appRoot === null) options.appRoot = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.appRoot) throw new Error("Usage: bun run release:vendor <appRoot> [--write] [--from <releasesDir>]");
  if (options.from === undefined || options.from === "") throw new Error("--from needs a releases directory");
  return options;
}

/**
 * Plans and (with write: true) applies the vendoring. Every check runs before
 * the first change to the app. `afterVerify` is a test hook called once the
 * release tarballs are verified and before anything is written.
 */
export function vendorApp({ appRoot: appRootArg, releasesDir: releasesArg, write = false, log = console.log, afterVerify }) {
  if (!existsSync(resolve(appRootArg))) throw new Error(`No such folder: ${appRootArg}`);
  const appRoot = realpathSync(resolve(appRootArg));
  const releasesDir = realpathSync(resolve(releasesArg));
  const manifestPath = join(releasesDir, "manifest.json");
  if (!existsSync(join(appRoot, "package.json"))) throw new Error(`No package.json in ${appRoot}`);
  if (!existsSync(manifestPath)) throw new Error(`No manifest.json in ${releasesDir}. Run bun run release:pack first.`);
  const manifest = loadManifest(readFileSync(manifestPath, "utf8"));

  // Every file this run reads from or may write to in the app must be a plain file inside it.
  assertPlainInside(appRoot, "package.json", "Root");
  const rootText = readFileSync(join(appRoot, "package.json"), "utf8");
  const { paths: workspacePaths, warnings } = discoverWorkspaces(appRoot, JSON.parse(rootText));
  const packageJsons = [
    { relPath: "package.json", text: rootText },
    ...workspacePaths.map((relPath) => ({ relPath, text: readFileSync(join(appRoot, relPath), "utf8") })),
  ];
  assertPlainInside(appRoot, "vendor", "Folder");
  const vendorExists = assertPlainInside(appRoot, VENDOR_DIR, "Folder");
  const vendorAbs = join(appRoot, VENDOR_DIR);
  const existingVendorFiles = vendorExists ? readdirSync(vendorAbs) : [];
  for (const file of existingVendorFiles) assertPlainInside(appRoot, `${VENDOR_DIR}/${file}`, "Vendored file");
  const ledgerPath = join(vendorAbs, LEDGER_FILE);
  const ledger = parseLedger(existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : null);

  const releaseOf = createReleaseLoader(releasesDir, manifest);
  const plan = planVendor({ packageJsons, releaseOf, ledger, existingVendorFiles });

  const copies = plan.tarballs.map((tarball) => {
    const release = releaseOf(tarball.name);
    const dest = join(vendorAbs, tarball.file);
    if (dirname(dest) !== vendorAbs) throw new Error(`${tarball.file} would be written outside ${VENDOR_DIR}`);
    // Keep only an exact byte match: bun installs these bytes, and a tar parser
    // differential could make different bytes share a contents digest.
    let action = "copy";
    let ownedIntegrity = null;
    if (existsSync(dest)) {
      const existing = readFileSync(dest);
      const owned = ledger.files[tarball.file];
      if (existing.equals(release.bytes)) action = "keep";
      else if (owned && integrity(existing) === owned.integrity) {
        action = "replace";
        ownedIntegrity = owned.integrity;
      }
      else {
        throw new Error(
          `${VENDOR_DIR}/${tarball.file} in the app is not App Patterns Framework's release of ${tarball.name} ${tarball.version}, and ` +
            `${LEDGER_FILE} does not show release:vendor placed it unchanged. ` +
            "Released versions are immutable; find out which build the app has, then remove it by hand.",
        );
      }
    }
    // The ledger only ever records the release's own integrity.
    const placedIntegrity = release.integrity;
    return { ...tarball, bytes: release.bytes, dest, action, placedIntegrity, ownedIntegrity };
  });

  // The ledger lives in the app and may be forged, so it alone never
  // authorises a deletion: the bytes must also
  // be a release App Patterns Framework itself recorded under that exact file name.
  const removals = [];
  const leftInPlace = [];
  for (const { file, integrity: recorded } of plan.ledgerRemovals) {
    const path = join(vendorAbs, file);
    if (!existsSync(path)) continue;
    const actual = integrity(readFileSync(path));
    if (actual !== recorded) leftInPlace.push(`${file} (changed since release:vendor placed it)`);
    else if (manifest.released[file]?.integrity !== actual) {
      leftInPlace.push(`${file} (not byte-identical to a App Patterns Framework release, so it could not be regenerated)`);
    } else removals.push({ file, integrity: actual });
  }
  for (const file of plan.unowned) leftInPlace.push(`${file} (not placed by release:vendor)`);

  const ledgerFiles = Object.fromEntries(
    copies.map((copy) => [copy.file, { name: copy.name, version: copy.version, integrity: copy.placedIntegrity }]),
  );
  const ledgerText = formatLedger(ledgerFiles);
  const ledgerChanged = !existsSync(ledgerPath) || readFileSync(ledgerPath, "utf8") !== ledgerText;
  afterVerify?.();

  log(`App Patterns Framework packages for ${appRoot}:`);
  const verbs = { copy: "add    ", replace: "replace", keep: "keep   " };
  for (const copy of copies) log(`  ${verbs[copy.action]} ${VENDOR_DIR}/${copy.file}`);
  for (const { file } of removals) log(`  remove ${VENDOR_DIR}/${file}`);
  for (const entry of leftInPlace) log(`  left in place: ${VENDOR_DIR}/${entry}`);
  if (ledgerChanged) log(`  write  ${VENDOR_DIR}/${LEDGER_FILE}`);
  for (const warning of warnings) log(`  warning: ${warning}`);
  for (const file of plan.files) {
    log(`\n--- ${file.relPath}`);
    if (file.addedPeers.length) log(`    (adds peers: ${file.addedPeers.join(", ")})`);
    for (const line of lineDiff(file.before, file.after)) log(line);
  }
  if (!plan.files.length) log("\nNo package.json changes.");

  const guarded = [...packageJsons.map((p) => p.relPath), VENDOR_DIR];
  if (!write) {
    let dirty;
    try {
      dirty = gitStatus(appRoot, guarded);
    } catch (error) {
      dirty = error.message;
    }
    if (dirty) log(`\nNote: --write will refuse until these are committed:\n${dirty}`);
    log("\nDry run. Re-run with --write to apply.");
    return { plan, copies, removals: removals.map((r) => r.file), leftInPlace };
  }

  const dirty = gitStatus(appRoot, guarded);
  if (dirty) {
    throw new Error(
      `Refusing to write: uncommitted changes in the app's package.json files or ${VENDOR_DIR}:\n${dirty}\nCommit or stash them first.`,
    );
  }

  // Re-check the folders immediately before writing: a gitignored vendor/app-patterns
  // can change between verification and here.
  ensurePlainDir(appRoot, "vendor");
  const vendorDir = ensurePlainDir(appRoot, VENDOR_DIR);
  // A replacement is authorised only by the bytes the ledger recorded; re-read
  // them now (all first, so a refusal writes nothing) and again just before each write.
  const assertStillOwned = (copy) => {
    const stat = lstatSafe(join(vendorDir, copy.file));
    if (!stat?.isFile() || integrity(readFileSync(join(vendorDir, copy.file))) !== copy.ownedIntegrity) {
      throw new Error(
        `${VENDOR_DIR}/${copy.file} changed during the run; it no longer matches ${LEDGER_FILE}, so release:vendor will not replace it.`,
      );
    }
  };
  for (const copy of copies) if (copy.action === "replace") assertStillOwned(copy);
  for (const copy of copies) {
    if (copy.action === "keep") continue;
    if (copy.action === "replace") assertStillOwned(copy);
    writeReplacing(vendorDir, copy.file, copy.bytes);
  }
  for (const { file, integrity: verified } of removals) {
    const path = join(vendorDir, file);
    const stat = lstatSafe(path);
    // unlink removes a link itself, never its target; still delete only the verified bytes.
    if (stat?.isFile() && integrity(readFileSync(path)) === verified) unlinkSync(path);
    else log(`  left in place: ${VENDOR_DIR}/${file} (changed during the run)`);
  }
  if (ledgerChanged) writeReplacing(vendorDir, LEDGER_FILE, ledgerText);
  for (const file of plan.files) {
    const dir = posix.dirname(file.relPath);
    if (dir !== ".") assertPlainInside(appRoot, dir, "Workspace folder");
    const absDir = dir === "." ? appRoot : join(appRoot, dir);
    if (realpathSync(absDir) !== absDir) throw new Error(`${dir} resolves outside the app; release:vendor wrote nothing further.`);
    writeReplacing(absDir, posix.basename(file.relPath), file.after);
  }
  log(`\nWrote ${plan.files.length} package.json file(s) and ${VENDOR_DIR}/.`);
  log("\nNext, in the app:");
  log("  rm -rf node_modules && bun install && bun install --frozen-lockfile");
  log("  (first move off file: folder links: also delete bun.lock before installing)");
  log(`  then commit package.json, bun.lock and ${VENDOR_DIR}/ together.`);
  return { plan, copies, removals: removals.map((r) => r.file), leftInPlace };
}

const frameworkRoot = fileURLToPath(new URL("..", import.meta.url));

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    vendorApp({
      appRoot: options.appRoot,
      releasesDir: options.from ?? join(frameworkRoot, "releases"),
      write: options.write,
    });
  } catch (error) {
    console.error(`\nrelease:vendor failed: ${error.message}`);
    process.exit(1);
  }
}
