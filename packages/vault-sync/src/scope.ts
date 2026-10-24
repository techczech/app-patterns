/**
 * Backup scope: an explicit list of include paths or globs plus excludes, matched against
 * worktree-relative POSIX paths. The folder is never added wholesale.
 *
 * Pattern rules: a pattern without glob characters names a file or a directory (and everything
 * under it). `*` and `?` match within one path segment, `[...]` is a character class, and a `**`
 * segment matches any number of segments. `.git` entries and nested repositories are never listed.
 *
 * Symlinks: a symlink is listed as a leaf (stored as a link, never followed). The walk never descends
 * through a symlinked directory, and a literal base whose path passes through a symlinked directory is
 * skipped with reason "beyond-symlink" (Git refuses such paths for the same reason).
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface BackupScope {
  include: readonly string[];
  exclude?: readonly string[];
}

interface Pattern {
  source: string;
  regex: RegExp;
  /** Leading literal directory to walk from ("" = worktree root). */
  base: string;
}

export interface CompiledScope {
  includes: Pattern[];
  excludes: Pattern[];
  isIncluded(path: string): boolean;
  isExcluded(path: string): boolean;
}

const GLOB_CHARS = /[*?[]/;

function normalise(pattern: string): string {
  if (typeof pattern !== "string" || pattern.length === 0) throw new Error("scope pattern must be a non-empty string");
  if (pattern.includes("\0")) throw new Error("scope pattern must not contain NUL");
  let p = pattern;
  while (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new Error(`scope pattern must be relative: ${pattern}`);
  p = p.replace(/\/+$/, "");
  const segments = p.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) throw new Error(`scope pattern has an invalid segment: ${pattern}`);
  return p;
}

function escapeRe(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function segmentToRe(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "[") {
      const close = segment.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      let body = segment.slice(i + 1, close);
      let negate = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negate = true;
        body = body.slice(1);
      }
      out += `[${negate ? "^/" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = close;
    } else out += escapeRe(ch);
  }
  return out;
}

export function compilePattern(pattern: string): Pattern {
  const p = normalise(pattern);
  const segments = p.split("/");
  if (!GLOB_CHARS.test(p)) {
    return { source: pattern, regex: new RegExp(`^${escapeRe(p)}(?:/.*)?$`, "s"), base: p };
  }
  let re = "";
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === "**") {
      if (last) re += i === 0 ? ".*" : "(?:/.*)?";
      else re += i === 0 ? "(?:.*/)?" : "(?:/.*)?/";
    } else {
      if (i > 0 && segments[i - 1] !== "**") re += "/";
      re += segmentToRe(segment);
    }
  });
  const literal: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (GLOB_CHARS.test(segment)) break;
    literal.push(segment);
  }
  return { source: pattern, regex: new RegExp(`^${re}$`, "s"), base: literal.join("/") };
}

export function compileScope(scope: BackupScope): CompiledScope {
  if (!scope || !Array.isArray(scope.include) || scope.include.length === 0) throw new Error("scope needs at least one include pattern");
  const includes = scope.include.map(compilePattern);
  const excludes = (scope.exclude ?? []).map(compilePattern);
  return {
    includes,
    excludes,
    isIncluded: (path) => includes.some((p) => p.regex.test(path)),
    isExcluded: (path) => isGitPath(path) || excludes.some((p) => p.regex.test(path)),
  };
}

function isGitPath(path: string): boolean {
  return path.split("/").includes(".git");
}

export interface SkippedPath {
  path: string;
  reason: "beyond-symlink";
}

export interface ScopeListing {
  /** Scoped regular files and symlinks, as sorted worktree-relative POSIX paths. */
  files: string[];
  /** Include bases (or walked directories) that were not traversed because they lie beyond a symlink. */
  skipped: SkippedPath[];
}

/** Lists scoped regular files and symlinks under root, as sorted worktree-relative POSIX paths. */
export async function listScopedFiles(root: string, scope: CompiledScope): Promise<string[]> {
  return (await listScope(root, scope)).files;
}

/** Lists scoped files and reports include bases that were skipped because they lie beyond a symlink. */
export async function listScope(root: string, scope: CompiledScope): Promise<ScopeListing> {
  const found = new Set<string>();
  const visited = new Set<string>();
  const skipped = new Map<string, SkippedPath>();
  const realRoot = await realpath(root);
  const skip = (path: string) => {
    if (!skipped.has(path)) skipped.set(path, { path, reason: "beyond-symlink" });
  };

  const walkDir = async (rel: string): Promise<void> => {
    if (visited.has(rel)) return;
    visited.add(rel);
    const dir = rel ? join(root, ...rel.split("/")) : root;
    // A directory swapped for a symlink after its parent was read must not be followed.
    try {
      if ((await realpath(dir)) !== (rel ? join(realRoot, ...rel.split("/")) : realRoot)) {
        skip(rel);
        return;
      }
    } catch {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name === ".git") continue;
      const child = rel ? `${rel}/${name}` : name;
      if (scope.isExcluded(child)) continue;
      // Dirent types come from lstat semantics: a symlinked directory is a symlink, never descended.
      if (entry.isDirectory()) {
        if (await isNestedRepo(join(root, child))) continue;
        await walkDir(child);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && scope.isIncluded(child)) {
        found.add(child);
      }
    }
  };

  const bases = [...new Set(scope.includes.map((p) => p.base))].sort();
  for (const base of bases) {
    if (base === "") {
      await walkDir("");
      continue;
    }
    // Every ancestor of the base must be walkable: not excluded, not a nested repository, and a real
    // directory (lstat each prefix; lstat follows symlinks in intermediate components).
    const parts = base.split("/");
    let blocked = false;
    for (let i = 1; i <= parts.length; i += 1) {
      const prefix = parts.slice(0, i).join("/");
      if (scope.isExcluded(prefix)) blocked = true;
      else if (i < parts.length) {
        let info;
        try {
          info = await lstat(join(root, ...parts.slice(0, i)));
        } catch {
          blocked = true;
          break;
        }
        if (info.isSymbolicLink()) {
          skip(base);
          blocked = true;
        } else if (!info.isDirectory()) blocked = true;
        else if (await isNestedRepo(join(root, prefix))) blocked = true;
      }
      if (blocked) break;
    }
    if (blocked) continue;
    let info;
    try {
      info = await lstat(join(root, ...parts));
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      if (!(await isNestedRepo(join(root, base)))) await walkDir(base);
    } else if ((info.isFile() || info.isSymbolicLink()) && scope.isIncluded(base)) {
      found.add(base);
    }
  }
  return { files: [...found].sort(), skipped: [...skipped.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

async function isNestedRepo(dir: string): Promise<boolean> {
  try {
    await lstat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}
