/**
 * The backup destination: one configured remote, checked at the start of every push, verification and
 * restore fetch. The check yields the literal address, and that operation then uses this address in the
 * engine's own transport context (transport.ts), never the remote name: the repository's configuration
 * is read here only to learn which address the user chose, and a change to it later in the operation has
 * no effect on where the operation goes.
 *
 * Supported set-up (anything else is refused as "unsupported-remote", never adapted):
 * - exactly one fetch address and at most one push address, and after Git's address rewriting the push
 *   and fetch addresses are the same, so the repository Git pushes to is the one `ls-remote` observes;
 * - the address is HTTPS, a file:// address or an absolute local path. SSH, git://, plain HTTP and
 *   remote helpers (`<helper>::...`) are not supported; the Git runner also forbids every other protocol;
 * - the remote section sets none of receivepack, uploadpack, vcs or mirror. The transport context never
 *   reads that section, and passes `--receive-pack`/`--upload-pack` explicitly, so such settings could
 *   not choose a program anyway; they are refused so the user is not misled about what runs.
 *
 * The address is the one `git remote get-url` reports, after the repository's address rewriting at the
 * time of the check; the visibility check and the enablement record see that same address.
 */
import { splitNul, type GitRunner, type GitRunOptions } from "./git-process.ts";

export interface Destination {
  name: string;
  /** The one address pushes, verification and restore use. May carry credentials: never log it. */
  url: string;
}

export type DestinationCheck = { destination: Destination } | { missing: true } | { unsupported: string };

const EXECUTABLE_KEYS = new Set(["receivepack", "uploadpack", "vcs", "mirror"]);

export function supportedAddress(url: string, platform: NodeJS.Platform = process.platform): boolean {
  if (/^https:\/\/[^/]/i.test(url)) return true;
  if (/^file:\/\/\//i.test(url)) return true;
  if (url.includes("::")) return false;
  return platform === "win32" ? /^[A-Za-z]:[\\/]/.test(url) : url.startsWith("/");
}

export async function checkDestination(git: GitRunner, run: GitRunOptions, name: string, platform: NodeJS.Platform = process.platform): Promise<DestinationCheck> {
  const section = await git.run(["config", "-z", "--includes", "--get-regexp", `^remote\\.${name.replace(/\./g, "\\.")}\\.`], run);
  if (section.code !== 0 && section.code !== 1) return { unsupported: "could not read the backup remote's settings" };
  const prefix = `remote.${name}.`;
  const counts = new Map<string, number>();
  for (const record of splitNul(section.stdout)) {
    const key = record.split("\n", 1)[0]!;
    if (!key.startsWith(prefix)) continue;
    const setting = key.slice(prefix.length).toLowerCase();
    counts.set(setting, (counts.get(setting) ?? 0) + 1);
  }
  if (!counts.get("url")) return { missing: true };
  for (const key of counts.keys()) {
    if (EXECUTABLE_KEYS.has(key)) return { unsupported: `the backup remote sets remote.${name}.${key}; automatic backup does not use remotes with that setting` };
  }
  if ((counts.get("url") ?? 0) > 1) return { unsupported: "the backup remote has more than one address; automatic backup needs exactly one" };
  if ((counts.get("pushurl") ?? 0) > 1) return { unsupported: "the backup remote has more than one push address; automatic backup needs exactly one" };
  const fetch = await git.run(["remote", "get-url", "--all", name], run);
  const push = await git.run(["remote", "get-url", "--push", "--all", name], run);
  if (fetch.code !== 0 || push.code !== 0) return { missing: true };
  const fetchUrls = fetch.stdout.toString("utf8").split("\n").filter(Boolean);
  const pushUrls = push.stdout.toString("utf8").split("\n").filter(Boolean);
  if (fetchUrls.length !== 1 || pushUrls.length !== 1) return { unsupported: "the backup remote resolves to more than one address; automatic backup needs exactly one" };
  if (fetchUrls[0] !== pushUrls[0]) return { unsupported: "the backup remote pushes to a different address than it reads from; automatic backup needs one address for both" };
  const url = pushUrls[0]!;
  if (!supportedAddress(url, platform)) return { unsupported: "the backup remote's address is not HTTPS or a local folder; other kinds of address are not supported for automatic backup" };
  return { destination: { name, url } };
}
