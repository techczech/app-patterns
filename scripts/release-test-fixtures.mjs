// Test fixtures for the release scripts: an in-memory tar writer, a fake
// releases/ folder with real tarballs and a manifest, and throwaway git apps.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { contentsDigest, integrity, readTarEntries } from "./release-tarball.mjs";

/** Minimal ustar writer. `files` maps archive path → content. */
export function tar(files, { mtime = 0 } = {}) {
  const blocks = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(`${mtime.toString(8).padStart(11, "0")}\0`, 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const madeDirs = [];
let exitHooked = false;

/** A fresh temp folder, removed when the process exits (and by callers' own rmSync, which is harmless to repeat). */
export function tempDir(label = "release-test-") {
  const d = mkdtempSync(join(tmpdir(), label));
  madeDirs.push(d);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => { for (const x of madeDirs.splice(0)) rmSync(x, { recursive: true, force: true }); });
  }
  return d;
}

/** A package tarball for `manifest` (package.json contents) plus a dist file. */
export function packageTarball(manifest, extraFiles = {}) {
  return gzipSync(
    tar({
      "package/package.json": JSON.stringify(manifest, null, 2),
      "package/dist/index.js": `export const name = ${JSON.stringify(manifest.name)};\n`,
      ...extraFiles,
    }),
  );
}

/**
 * Writes a releases/ folder. `packages` is a list of package.json objects for
 * @app-patterns packages; `tamper(manifest)` may alter the manifest before writing.
 */
export function writeReleases(dir, packages, { tamper } = {}) {
  mkdirSync(dir, { recursive: true });
  const manifest = { schema: 1, packages: {}, released: {} };
  for (const pkg of packages) {
    const file = `${pkg.name.slice(1).replace("/", "-")}-${pkg.version}.tgz`;
    const bytes = packageTarball(pkg);
    writeFileSync(join(dir, file), bytes);
    const record = {
      version: pkg.version,
      file,
      integrity: integrity(bytes),
      contentsDigest: contentsDigest(readTarEntries(bytes)),
      frameworkPeers: Object.fromEntries(
        Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith("@app-patterns/")),
      ),
      commit: "test",
      commitDirty: false,
      packedAt: "2026-10-20T00:00:00.000Z",
    };
    manifest.packages[pkg.name] = record;
    manifest.released[file] = { name: pkg.name, ...record };
  }
  tamper?.(manifest);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export const COMMANDS = { name: "@app-patterns/commands", version: "0.3.1" };
export const SETTINGS = { name: "@app-patterns/settings", version: "0.14.4", peerDependencies: { "@app-patterns/commands": "^0.3.0" } };

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** Creates a git repository with the given files committed. */
export function writeApp(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  git(dir, "init", "-q");
  commitAll(dir);
  return dir;
}

export function commitAll(dir) {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture");
}
