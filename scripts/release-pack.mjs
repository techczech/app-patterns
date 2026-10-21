#!/usr/bin/env bun
// bun run release:pack [--only settings,commands]
//
// Builds every workspace package in dependency order (`bun run build`), packs
// each package under packages/ with `bun pm pack` into
// releases/<scope-free-name>-<version>.tgz and records it in
// releases/manifest.json. A released version is immutable: repacking a version
// whose contents changed fails and asks for a version bump. See ADR-0001.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOrder } from "./run-workspaces.mjs";
import {
  contentsDigest,
  forbiddenContents,
  integrity,
  missingPromisedFiles,
  readTarEntries,
  tarballManifest,
} from "./release-tarball.mjs";

const MANIFEST_SCHEMA = 1;
const FRAMEWORK_SCOPE = "@app-patterns/";

export function tarballFileName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

export function emptyManifest() {
  return { schema: MANIFEST_SCHEMA, packages: {}, released: {} };
}

/** The @app-patterns/* peers a package declares, with their ranges. */
export function frameworkPeers(manifest) {
  return Object.fromEntries(
    Object.entries(manifest.peerDependencies ?? {})
      .filter(([name]) => name.startsWith(FRAMEWORK_SCOPE) && manifest.peerDependenciesMeta?.[name]?.optional !== true)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** Problems with a package's `files` field that would keep dist/ out of its tarball. */
export function filesFieldProblem(manifest) {
  if (!Array.isArray(manifest.files)) return null;
  const coversDist = manifest.files.some((entry) => /^(\.\/)?dist(\/|\/\*\*?)?$/.test(entry));
  return coversDist ? null : `"files" does not include "dist": ${JSON.stringify(manifest.files)}`;
}

/**
 * Decides what to do with a freshly packed tarball given what is already
 * released under the same file name.
 *   existingDigest: contentsDigest of releases/<file> on disk, if present
 *   recordedDigest: contentsDigest recorded in manifest.released[file], if any
 * Returns "new" (nothing released under this name), "same" (identical
 * contents; keep the released file). Throws when contents differ.
 */
export function immutabilityVerdict({ name, version, file, newDigest, existingDigest, recordedDigest, currentDigest }) {
  const known = [existingDigest, recordedDigest, currentDigest].filter(Boolean);
  if (known.length === 0) return "new";
  if (known.every((digest) => digest === newDigest)) return "same";
  const where = existingDigest && existingDigest !== newDigest ? `releases/${file}` : "releases/manifest.json";
  throw new Error(
    `${name} ${version}: ${where} already holds a different build of this version. ` +
      `Released versions are immutable; bump the version of ${name} and pack again.`,
  );
}

/**
 * Parses releases/manifest.json. Only an absent manifest (null) starts fresh;
 * a manifest that exists must be internally consistent: every record carries
 * its version, file (or name), integrity and contentsDigest, and every
 * `packages` record names a file listed in `released` with the same values.
 */
export function loadManifest(text) {
  if (text === null || text === undefined) return emptyManifest();
  const corrupt = (why) =>
    new Error(`releases/manifest.json is corrupt: ${why}. Restore it from git; do not delete it to start over.`);
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw corrupt(error.message);
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(manifest) || manifest.schema !== MANIFEST_SCHEMA) throw corrupt(`expected schema ${MANIFEST_SCHEMA}`);
  if (!isObject(manifest.packages)) throw corrupt(`"packages" is missing`);
  if (!isObject(manifest.released)) throw corrupt(`"released" is missing`);
  const isText = (value) => typeof value === "string" && value !== "";
  for (const [file, released] of Object.entries(manifest.released)) {
    for (const field of ["name", "version", "integrity", "contentsDigest"]) {
      if (!isObject(released) || !isText(released[field])) throw corrupt(`"released" ${file} has no ${field}`);
    }
  }
  for (const [name, record] of Object.entries(manifest.packages)) {
    for (const field of ["version", "file", "integrity", "contentsDigest"]) {
      if (!isObject(record) || !isText(record[field])) throw corrupt(`${name} has no ${field}`);
    }
    const released = manifest.released[record.file];
    if (!released) throw corrupt(`${name} points at ${record?.file}, which "released" does not list`);
    if (
      released.name !== name ||
      released.version !== record.version ||
      released.contentsDigest !== record.contentsDigest ||
      released.integrity !== record.integrity
    ) {
      throw corrupt(`${name} disagrees with "released" for ${record.file}`);
    }
  }
  return manifest;
}

/** Records a packed tarball in the manifest; returns a new manifest object. */
export function recordRelease(manifest, entry) {
  const previous = manifest.released?.[entry.file];
  const kept = previous && previous.contentsDigest === entry.contentsDigest;
  const released = {
    name: entry.name,
    version: entry.version,
    integrity: entry.integrity,
    contentsDigest: entry.contentsDigest,
    commit: kept ? previous.commit : entry.commit,
    commitDirty: kept ? previous.commitDirty : entry.commitDirty,
    packedAt: kept ? previous.packedAt : entry.packedAt,
  };
  return {
    schema: MANIFEST_SCHEMA,
    packages: {
      ...manifest.packages,
      [entry.name]: {
        version: entry.version,
        file: entry.file,
        integrity: released.integrity,
        contentsDigest: released.contentsDigest,
        frameworkPeers: entry.frameworkPeers,
        commit: released.commit,
        commitDirty: released.commitDirty,
        packedAt: released.packedAt,
      },
    },
    released: { ...manifest.released, [entry.file]: released },
  };
}

export function sortManifest(manifest) {
  const sortKeys = (object) =>
    Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { schema: manifest.schema, packages: sortKeys(manifest.packages), released: sortKeys(manifest.released) };
}

export function parseArgs(argv) {
  const options = { only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--only") {
      options.only = argv[++index];
    } else if (arg.startsWith("--only=")) {
      options.only = arg.slice("--only=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.only !== null) {
    if (!options.only) throw new Error("--only needs a comma-separated list of package names");
    options.only = options.only
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => (name.startsWith(FRAMEWORK_SCOPE) ? name : `${FRAMEWORK_SCOPE}${name}`));
  }
  return options;
}

// ---------------------------------------------------------------------------

const root = fileURLToPath(new URL("..", import.meta.url));
const releasesDir = join(root, "releases");
const manifestPath = join(releasesDir, "manifest.json");

function run(command, args, cwd, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}${detail}`);
  }
  return capture ? result.stdout : "";
}

function readWorkspaces() {
  const packagesDir = join(root, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")))
    .map((entry) => {
      const dir = join(packagesDir, entry.name);
      return { dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) };
    });
}

function digestOfFile(path) {
  return existsSync(path) ? contentsDigest(readTarEntries(readFileSync(path))) : null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspaces = readWorkspaces();
  const byName = new Map(workspaces.map((w) => [w.manifest.name, w]));
  if (options.only) {
    const unknown = options.only.filter((name) => !byName.has(name));
    if (unknown.length) throw new Error(`Not a App Patterns Framework package: ${unknown.join(", ")}`);
  }
  const order = buildOrder(workspaces.map((w) => w.manifest)).filter(
    (name) => !options.only || options.only.includes(name),
  );

  for (const name of order) {
    const problem = filesFieldProblem(byName.get(name).manifest);
    if (problem) throw new Error(`${name}: ${problem}. Fix its package.json before packing.`);
  }

  // rmSync removes a dist symlink itself, never its target. Keep the path
  // fixed here: no manifest field or CLI argument can widen the deletion.
  for (const { dir } of workspaces) rmSync(join(dir, "dist"), { recursive: true, force: true });
  console.log("==> building all packages from clean dist/ (bun run build)");
  run(process.execPath, ["run", "build"], root);

  const commit = run("git", ["rev-parse", "HEAD"], root, { capture: true }).trim();
  const staging = join(releasesDir, ".staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  let manifest = loadManifest(existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null);
  const summary = [];
  try {
    for (const name of order) {
      const { dir, manifest: source } = byName.get(name);
      const file = tarballFileName(name, source.version);
      const stagedPath = join(staging, file);
      const packed = run(process.execPath, ["pm", "pack", "--quiet", "--filename", stagedPath], dir, {
        capture: true,
      });
      if (!existsSync(stagedPath)) throw new Error(`${name}: bun pm pack did not write ${file}\n${packed}`);

      const bytes = readFileSync(stagedPath);
      const entries = readTarEntries(bytes);
      const packedManifest = tarballManifest(entries);
      const missing = missingPromisedFiles(packedManifest, entries);
      if (missing.length) {
        throw new Error(`${name}: tarball is missing files its package.json promises: ${missing.join(", ")}`);
      }
      const forbidden = forbiddenContents(entries);
      if (forbidden.length) {
        throw new Error(
          `${name}: tarball contains files consumers must not receive:\n  ${forbidden.join("\n  ")}\n` +
            `Narrow "files" in its package.json to what consumers need (normally ["dist"]).`,
        );
      }
      const workspaceRanges = JSON.stringify(packedManifest).match(/"workspace:[^"]*"/g);
      if (workspaceRanges) throw new Error(`${name}: tarball still contains ${workspaceRanges.join(", ")}`);

      const newDigest = contentsDigest(entries);
      const releasedPath = join(releasesDir, file);
      const verdict = immutabilityVerdict({
        name,
        version: source.version,
        file,
        newDigest,
        existingDigest: digestOfFile(releasedPath),
        recordedDigest: manifest.released[file]?.contentsDigest,
        currentDigest:
          manifest.packages[name]?.file === file ? manifest.packages[name].contentsDigest : undefined,
      });
      if (verdict === "new" || !existsSync(releasedPath)) renameSync(stagedPath, releasedPath);
      const finalBytes = readFileSync(releasedPath);
      const dirty =
        run("git", ["status", "--porcelain", "--", relative(root, dir)], root, { capture: true }).trim() !== "";
      manifest = recordRelease(manifest, {
        name,
        version: source.version,
        file,
        integrity: integrity(finalBytes),
        contentsDigest: newDigest,
        frameworkPeers: frameworkPeers(source),
        commit,
        commitDirty: dirty,
        packedAt: new Date().toISOString(),
      });
      summary.push({ name, file, verdict, size: finalBytes.length, files: entries.length });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  writeFileSync(manifestPath, `${JSON.stringify(sortManifest(manifest), null, 2)}\n`);
  console.log("\n==> releases");
  for (const row of summary) {
    const state = row.verdict === "new" ? "packed" : "unchanged, kept";
    console.log(`  ${row.file.padEnd(40)} ${(row.size / 1024).toFixed(1).padStart(8)} KB  ${String(row.files).padStart(4)} files  ${state}`);
  }
  console.log(`\nWrote ${relative(root, manifestPath)}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`\nrelease:pack failed: ${error.message}`);
    process.exit(1);
  }
}
