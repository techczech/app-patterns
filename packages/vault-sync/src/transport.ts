/**
 * Network Git for the engine (push, verification, restore fetch) runs in a transport context the engine
 * owns, never in the user's repository:
 *
 * - a fresh private git directory per operation (mode 0700, removed afterwards) whose whole configuration
 *   is the constant below, with GIT_OBJECT_DIRECTORY pointing at the checkout's object store so objects
 *   are read from and fetched into the checkout as usual;
 * - no system or user Git configuration (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null);
 * - the destination is the literal address validated for this operation (destination.ts), never a remote
 *   name, so changing the remote while a scan runs cannot redirect the push.
 *
 * So nothing in the repository's configuration (or the user's) can rewrite the address
 * (`url.*.insteadOf`), allow another transport (`protocol.<name>.allow`), weaken TLS (`http.sslVerify`,
 * `http.<url>.*`), add headers or proxies, or choose a credential helper. What remains is what the
 * application supplies: its own environment (for example GIT_SSL_CAINFO for a private certificate
 * authority, HTTPS_PROXY), its `gitEnv`, and its `trustedCredentialHelpers` (git-process.ts).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner, GitRunOptions } from "./git-process.ts";

/** Fixed programs for the far side of a local transport; configuration cannot replace them. */
export const PUSH_TRANSPORT = ["--receive-pack=git-receive-pack"];
export const FETCH_TRANSPORT = ["--upload-pack=git-upload-pack"];

function transportConfig(format: "sha1" | "sha256"): string {
  return format === "sha256"
    ? "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n"
    : "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";
}

export interface ObjectStore {
  /** The checkout's object directory (`<common git dir>/objects`). */
  objectsDir: string;
  format: "sha1" | "sha256";
}

export interface TransportContext {
  /** Run options for a git call in this context, with the caller's time and output limits. */
  options(base: Omit<GitRunOptions, "cwd" | "env">): GitRunOptions;
}

/** Runs `fn` with a fresh transport context bound to the checkout's object store; removed afterwards. */
export async function withTransport<T>(store: ObjectStore, fn: (t: TransportContext) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "vault-sync-transport-"));
  try {
    await mkdir(join(dir, "refs", "heads"), { recursive: true, mode: 0o700 });
    await mkdir(join(dir, "refs", "tags"), { mode: 0o700 });
    await mkdir(join(dir, "objects"), { mode: 0o700 });
    await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
    await writeFile(join(dir, "config"), transportConfig(store.format), { mode: 0o600 });
    const env = { GIT_DIR: dir, GIT_OBJECT_DIRECTORY: store.objectsDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull };
    return await fn({ options: (base) => ({ ...base, cwd: dir, env }) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type NetworkLimits = Omit<GitRunOptions, "cwd" | "env" | "input" | "stopAfterBytes">;

/** Pushes `oid` to `ref` at `url` from a transport context (normal push, never forced). Resolves with git's result. */
export async function pushIn(git: GitRunner, t: TransportContext, url: string, oid: string, ref: string, limits: NetworkLimits) {
  await git.ok(["update-ref", ref, oid], t.options(limits));
  return git.run(["push", ...PUSH_TRANSPORT, "--porcelain", "--no-follow-tags", "--no-signed", "--recurse-submodules=no", url, `${ref}:${ref}`], t.options(limits));
}

/** `git ls-remote --refs` at `url` for the given ref patterns. */
export function lsRemoteAt(git: GitRunner, store: ObjectStore, url: string, patterns: readonly string[], limits: NetworkLimits): Promise<Buffer> {
  return withTransport(store, (t) => git.ok(["ls-remote", ...FETCH_TRANSPORT, "--refs", url, ...patterns], t.options(limits)));
}

/**
 * Fetches the destination's `refs/heads/backup/*` into the checkout's object store and returns each
 * branch's object id. `have` seeds the context with refs the checkout already holds, so only new objects
 * are transferred. Refs are written only inside the transport context.
 */
export function fetchBackupBranches(git: GitRunner, store: ObjectStore, url: string, have: ReadonlyMap<string, string>, limits: NetworkLimits): Promise<Map<string, string>> {
  return withTransport(store, async (t) => {
    if (have.size > 0) {
      const lines = [...have].map(([ref, oid]) => `create ${ref} ${oid}\n`).join("");
      await git.ok(["update-ref", "--stdin"], { ...t.options(limits), input: Buffer.from(lines, "utf8") });
    }
    await git.ok(["fetch", ...FETCH_TRANSPORT, "--quiet", "--prune", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-gc", "--refmap=", url, "+refs/heads/backup/*:refs/heads/backup/*"], t.options(limits));
    const out = await git.ok(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/backup/"], t.options(limits));
    const found = new Map<string, string>();
    for (const line of out.toString("utf8").split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0) found.set(line.slice(space + 1), line.slice(0, space));
    }
    return found;
  });
}
