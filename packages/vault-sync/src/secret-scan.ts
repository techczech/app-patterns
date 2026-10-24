/**
 * Secret scanning before a backup push. The engine's commits are made with plumbing, so no commit hook
 * ever scans them; this module does it instead.
 *
 * - `collectPushBlobs` lists every blob reachable from the snapshot about to be pushed: the whole backup
 *   chain, every time. Nothing (remote-tracking refs, earlier receipts, what the destination advertises)
 *   is taken as evidence that the destination already holds something, because a destination can drop a
 *   ref between any listing and the push, and Git then sends those objects again. The cost grows with the
 *   chain; the total-size limit holds the push back rather than skipping any of it.
 * - A scanner is a function from blobs to findings. Findings carry a path and a rule id only; nothing
 *   here ever returns, logs or throws secret text or file contents.
 * - `createGitleaksScanner` materialises the blobs in a private temporary folder, runs
 *   `gitleaks detect --no-git --redact` over it, reads the JSON report and deletes the folder.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { splitNul, type GitRunner, type GitRunOptions } from "./git-process.ts";

export interface ScanBlob {
  path: string;
  oid: string;
  bytes: Buffer;
}

export interface SecretFinding {
  path: string;
  rule: string;
}

export type SecretScanResult = { findings: SecretFinding[] } | { unavailable: string };

export type SecretScanner = (blobs: ScanBlob[]) => Promise<SecretScanResult>;

export interface NotScannedBlob {
  path: string;
  oid: string;
  size: number;
  binary: boolean;
}

export interface PushBlobs {
  blobs: ScanBlob[];
  /** Blobs larger than the scan limit. Binary ones may be pushed; text ones block the push. */
  notScanned: NotScannedBlob[];
  /** True when the blobs to scan together exceed `maxTotalBytes`; the push is then held back. */
  overTotal: boolean;
}

export interface CollectOptions {
  git: GitRunner;
  run: GitRunOptions;
  newTip: string;
  maxBlobBytes: number;
  /** Upper bound on the bytes held for one scan. */
  maxTotalBytes: number;
}

/** Needs Git 2.47 or later (`rev-list -z`). A failure here blocks the push rather than skipping the scan. */
export async function collectPushBlobs(options: CollectOptions): Promise<PushBlobs> {
  const { git, run } = options;
  const tokens = splitNul(await git.ok(["rev-list", "-z", "--objects", "--stdin"], { ...run, input: Buffer.from(`${options.newTip}\n`, "utf8") }));
  const paths = new Map<string, string>();
  const order: string[] = [];
  let last: string | null = null;
  for (const token of tokens) {
    if (token.startsWith("path=") && last) {
      if (!paths.has(last)) paths.set(last, token.slice(5));
      continue;
    }
    if (/^[0-9a-f]{40,64}$/.test(token)) {
      last = token;
      order.push(token);
    }
  }
  if (order.length === 0) return { blobs: [], notScanned: [], overTotal: false };
  const check = (await git.ok(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { ...run, input: Buffer.from(`${order.join("\n")}\n`, "utf8") })).toString("utf8");
  const result: PushBlobs = { blobs: [], notScanned: [], overTotal: false };
  let total = 0;
  const seen = new Set<string>();
  const wanted: { oid: string; size: number; path: string }[] = [];
  for (const line of check.split("\n")) {
    const [oid, type, sizeText] = line.split(" ");
    if (!oid) continue;
    // Every listed object must exist here; a missing one would otherwise be left out of the scan.
    if (type === "missing") throw new Error("an object to be sent is missing from this repository");
    if (type !== "blob" || seen.has(oid)) continue;
    seen.add(oid);
    const size = Number(sizeText);
    const path = paths.get(oid) ?? oid;
    if (size > options.maxBlobBytes) {
      result.notScanned.push({ path, oid, size, binary: await isBinaryBlob(options, oid) });
      continue;
    }
    total += size;
    if (total > options.maxTotalBytes) {
      result.overTotal = true;
      result.blobs = [];
      return result;
    }
    wanted.push({ oid, size, path });
  }
  // Read in batches, one git process each, each batch's output kept under the run's output limit.
  const budget = Math.max(1, Math.floor(run.maxOutputBytes / 2));
  for (let start = 0; start < wanted.length;) {
    let end = start;
    let bytes = 0;
    while (end < wanted.length && (end === start || bytes + wanted[end]!.size + 128 <= budget)) bytes += wanted[end++]!.size + 128;
    const batch = wanted.slice(start, end);
    const out = await git.ok(["cat-file", "--batch"], { ...run, input: Buffer.from(`${batch.map((b) => b.oid).join("\n")}\n`, "utf8") });
    let at = 0;
    for (const item of batch) {
      const eol = out.indexOf(0x0a, at);
      const header = eol < 0 ? "" : out.subarray(at, eol).toString("utf8");
      if (header !== `${item.oid} blob ${item.size}` || out.length < eol + 1 + item.size + 1) throw new Error("git returned an unexpected object while reading blobs to scan");
      result.blobs.push({ path: item.path, oid: item.oid, bytes: Buffer.from(out.subarray(eol + 1, eol + 1 + item.size)) });
      at = eol + 1 + item.size + 1;
    }
    start = end;
  }
  return result;
}

/** Git's binary test: a NUL byte in the first 8000 bytes. Only those bytes are read. */
async function isBinaryBlob(options: CollectOptions, oid: string): Promise<boolean> {
  const head = await options.git.ok(["cat-file", "blob", oid], { ...options.run, stopAfterBytes: 8000 });
  return head.includes(0);
}

export interface GitleaksOptions {
  /** Absolute path, or a bare name looked up in `searchDirs`. Default "gitleaks". */
  gitleaksPath?: string;
  /** Folders searched for a bare name. Default: PATH, then the usual package-manager folders. */
  searchDirs?: readonly string[];
  timeoutMs?: number;
  /** Larger reports are treated as a failed scan. Default 16 MiB. */
  maxReportBytes?: number;
}

/** Package-manager folders that a GUI app's PATH usually lacks. */
const EXTRA_DIRS = process.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin"];

/** Absolute path of an executable file, or null. No shell, no `which`. */
export async function resolveExecutable(name: string, dirs: readonly string[]): Promise<string | null> {
  const candidates = isAbsolute(name) ? [name] : name.includes("/") || name.includes("\\") ? [] : dirs.filter((d) => isAbsolute(d)).flatMap((d) => process.platform === "win32" ? [join(d, `${name}.exe`), join(d, name)] : [join(d, name)]);
  for (const candidate of candidates) {
    try {
      const s = await stat(candidate);
      if (!s.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

/** Environment for the scanner: no GITLEAKS_* variables, so no outside config or ignore file applies. */
function scannerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.toUpperCase().startsWith("GITLEAKS")) continue;
    env[key] = value;
  }
  return env;
}

/** Keeps a repository path as nested folders when every segment is safe, otherwise uses a fixed name. */
function safeRelative(path: string): string[] {
  const segments = path.split("/");
  const ok = segments.every((s) => s !== "" && s !== "." && s !== ".." && !s.includes("\0") && !s.includes("\\") && !/^[A-Za-z]:/.test(s));
  return ok ? segments : ["blob"];
}

export function createGitleaksScanner(options: GitleaksOptions = {}): SecretScanner {
  const name = options.gitleaksPath ?? "gitleaks";
  const dirs = options.searchDirs ?? [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...EXTRA_DIRS];
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxReportBytes = options.maxReportBytes ?? 16 * 1024 * 1024;
  return async (blobs) => {
    const command = await resolveExecutable(name, dirs);
    if (!command) return { unavailable: "scanner missing: gitleaks is not installed" };
    if (blobs.length === 0) return { findings: [] };
    const made = await mkdtemp(join(tmpdir(), "vault-sync-scan-"));
    try {
      await chmod(made, 0o700);
      const dir = await realpath(made);
      const source = join(dir, "source");
      await mkdir(source, { mode: 0o700 });
      // Each blob goes in its own numbered folder so a finding maps back to exactly one blob.
      for (const [index, blob] of blobs.entries()) {
        const segments = safeRelative(blob.path);
        const parent = join(source, String(index), ...segments.slice(0, -1));
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await writeFile(join(parent, segments[segments.length - 1]!), blob.bytes, { mode: 0o600 });
      }
      const report = join(dir, "report.json");
      const outcome = await runGitleaks(command, ["detect", "--no-git", "--source", source, "--report-format", "json", "--report-path", report, "--redact", "--no-banner", "--log-level", "error", "--exit-code", "3"], dir, timeoutMs);
      if (outcome === "missing") return { unavailable: "scanner missing: gitleaks is not installed" };
      if (outcome === "timeout") return { unavailable: "gitleaks did not finish in time" };
      if (outcome !== 0 && outcome !== 3) return { unavailable: `gitleaks failed (exit ${outcome})` };
      let parsed: unknown;
      try {
        if ((await stat(report)).size > maxReportBytes) return { unavailable: "gitleaks wrote an oversized report" };
        parsed = JSON.parse(await readFile(report, "utf8"));
      } catch {
        return { unavailable: "gitleaks wrote no readable report" };
      }
      if (!Array.isArray(parsed)) return { unavailable: "gitleaks wrote an unexpected report" };
      if (outcome === 3 && parsed.length === 0) return { unavailable: "gitleaks reported leaks but listed none" };
      const findings: SecretFinding[] = [];
      const keys = new Set<string>();
      for (const item of parsed) {
        const rule = typeof item?.RuleID === "string" ? item.RuleID : "unknown-rule";
        const file = typeof item?.File === "string" ? item.File : "";
        const rel = relative(source, file.startsWith(source) ? file : join(source, file)).split(sep);
        const blob = blobs[Number(rel[0])];
        const path = blob ? blob.path : "(unknown file)";
        const key = `${path}\0${rule}`;
        if (keys.has(key)) continue;
        keys.add(key);
        findings.push({ path, rule });
      }
      return { findings };
    } finally {
      await rm(made, { recursive: true, force: true });
    }
  };
}

/** Runs gitleaks with no shell; its output is discarded so nothing it prints can reach a log. */
function runGitleaks(command: string, args: string[], cwd: string, timeoutMs: number): Promise<number | "missing" | "timeout"> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, env: scannerEnv(), stdio: ["ignore", "ignore", "ignore"], shell: false, windowsHide: true });
    } catch {
      resolve("missing");
      return;
    }
    let done = false;
    const finish = (value: number | "missing" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      finish("timeout");
    }, timeoutMs);
    child.on("error", (error) => finish((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : -1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Message for a blocked push: paths and rule ids only. */
export function describeFindings(findings: readonly SecretFinding[]): string {
  const listed = findings.slice(0, 20).map((f) => `${f.path} (${f.rule})`).join(", ");
  const more = findings.length > 20 ? ` and ${findings.length - 20} more` : "";
  return `secret scan found ${findings.length} possible secret${findings.length === 1 ? "" : "s"}: ${listed}${more}`;
}
