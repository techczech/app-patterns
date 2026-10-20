// Reads npm-style package tarballs (.tgz) without extracting them to disk, and
// computes the two fingerprints the release scripts rely on:
//   - integrity: sha512 of the tarball bytes in SRI form (what a lockfile records);
//   - contentsDigest: sha256 over the sorted file paths and file bytes inside the
//     tarball, independent of gzip settings and tar timestamps. Two packs of the
//     same build have the same contentsDigest even if their bytes differ.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;
// Regular files ("0", NUL, "7"), folders ("5"), pax headers ("x", "g") and GNU long names ("L").
// Anything else (links, devices, FIFOs, unknown types) is refused rather than skipped.
const KNOWN_TYPES = new Set(["0", "\0", "7", "5", "x", "g", "L"]);

function readString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(buffer, start, length) {
  const text = readString(buffer, start, length).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function parsePax(data) {
  const fields = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1) fields[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return fields;
}

/**
 * Lists the regular files in a tar archive (gzip-compressed or not).
 * Returns [{ path, data }] with the leading "package/" kept as written.
 * Throws on entry types other than files, folders and name records, on
 * truncated headers, payloads or padding, a missing pair of end-of-archive
 * blocks, and non-zero bytes after them.
 */
export function readTarEntries(bytes) {
  let buffer = Buffer.from(bytes);
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  let paxPath = null;
  let longName = null;
  let ended = false;
  while (offset < buffer.length) {
    if (offset + BLOCK > buffer.length) throw new Error("tar archive ends inside a header block");
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      // End of archive: two zero blocks, then only zero padding.
      if (offset + 2 * BLOCK > buffer.length) throw new Error("tar archive lacks its two end-of-archive blocks");
      if (!buffer.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("tar archive has data after its end-of-archive blocks");
      }
      ended = true;
      break;
    }
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const dataStart = offset + BLOCK;
    if (!KNOWN_TYPES.has(type)) {
      throw new Error(`tar entry ${JSON.stringify(name)} has type ${JSON.stringify(type)}; only files, folders and long-name records are allowed`);
    }
    const paddedEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (!Number.isFinite(size) || size < 0 || paddedEnd > buffer.length) {
      throw new Error(`tar entry ${JSON.stringify(name)} is truncated (payload or its 512-byte padding) or has an invalid size`);
    }
    if (type === "5" && size !== 0) throw new Error(`tar folder entry ${JSON.stringify(name)} carries data`);
    const data = buffer.subarray(dataStart, dataStart + size);
    offset = paddedEnd;

    if (type === "x") {
      paxPath = parsePax(data).path ?? null;
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = readString(data, 0, data.length);
      continue;
    }
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    longName = null;
    if (type === "0" || type === "\0" || type === "7") {
      entries.push({ path, data: Buffer.from(data) });
    }
  }
  if (!ended) throw new Error("tar archive lacks its two end-of-archive blocks");
  return entries;
}

/** Strips the single top-level folder npm and bun put every file under. */
export function packagePath(path) {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function contentsDigest(entries) {
  const hash = createHash("sha256");
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    const fileHash = createHash("sha256").update(entry.data).digest("hex");
    hash.update(`${packagePath(entry.path)}\0${fileHash}\n`);
  }
  return `sha256-${hash.digest("base64")}`;
}

export function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Returns the package.json inside a tarball, parsed. */
export function tarballManifest(entries) {
  const entry = entries.find((e) => packagePath(e.path) === "package.json");
  if (!entry) throw new Error("tarball has no package.json");
  return JSON.parse(entry.data.toString("utf8"));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Names the files a package manifest promises (exports targets, main, module,
 * types, bin) that are absent from the tarball. A subpath-pattern target with
 * one "*" must match at least one file; a target with more than one "*" is
 * rejected as unsupported.
 */
export function missingPromisedFiles(manifest, entries) {
  const present = [...new Set(entries.map((e) => packagePath(e.path)))];
  const presentSet = new Set(present);
  const promised = new Set();
  const visit = (value) => {
    if (typeof value === "string") promised.add(value.replace(/^\.\//, ""));
    else if (value && typeof value === "object") for (const inner of Object.values(value)) visit(inner);
  };
  visit(manifest.exports);
  for (const field of ["main", "module", "types", "typings"]) visit(manifest[field]);
  visit(manifest.bin);
  const missing = [];
  for (const target of [...promised].sort()) {
    const stars = target.split("*").length - 1;
    if (stars === 0) {
      if (!presentSet.has(target)) missing.push(target);
    } else if (stars === 1) {
      const [head, tail] = target.split("*");
      const pattern = new RegExp(`^${escapeRegExp(head)}.+${escapeRegExp(tail)}$`);
      if (!present.some((file) => pattern.test(file))) missing.push(`${target} (no file matches)`);
    } else {
      throw new Error(`export target ${target} has more than one "*"; that pattern shape is unsupported`);
    }
  }
  return missing;
}

const HOME_PATH = /\/Users\/[^/]+\//;
const WINDOWS_HOME_PATH = /[a-z]:[\\/]Users[\\/][^\\/]+[\\/]/i;

/**
 * Why a .map file may not ship, or null. Parses the map rather than matching
 * text, so an escaped or re-spelled key is still found; a map that does not
 * parse is refused because it cannot be checked.
 */
export function sourceMapProblem(data) {
  let map;
  try {
    map = JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    return "source map is not valid JSON, so it cannot be checked for sourcesContent";
  }
  if (map === null || typeof map !== "object" || Array.isArray(map)) return "source map is not a JSON object";
  // Indexed maps nest further maps under sections[].map to any depth; walk them
  // with an explicit stack so a deep map cannot overflow the call stack.
  const stack = [map];
  while (stack.length) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || Array.isArray(current)) continue;
    if (Array.isArray(current.sourcesContent) && current.sourcesContent.some((content) => content !== null && content !== undefined)) {
      return "source map embeds sourcesContent";
    }
    if (Array.isArray(current.sections)) for (const section of current.sections) stack.push(section?.map);
  }
  return null;
}

/**
 * Lists files a consumer must not receive: anything under src/, test files,
 * source maps that embed their sources, and files containing a macOS user-home path
 * or Windows drive-qualified user-home path. Sorted by path; empty when the tarball is clean.
 */
export function forbiddenContents(entries) {
  const problems = [];
  for (const entry of entries) {
    const path = packagePath(entry.path);
    if (path.startsWith("src/") || path.includes("/src/")) problems.push(`${path}: source folder`);
    else if (/\.test\./.test(path.split("/").at(-1))) problems.push(`${path}: test file`);
    else if (path.endsWith(".map") && sourceMapProblem(entry.data)) problems.push(`${path}: ${sourceMapProblem(entry.data)}`);
    else if (WINDOWS_HOME_PATH.test(entry.data.toString("latin1"))) problems.push(`${path}: contains a Windows user-home path`);
    else if (HOME_PATH.test(entry.data.toString("latin1"))) problems.push(`${path}: contains a macOS user-home path`);
  }
  return problems.sort();
}
