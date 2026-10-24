/**
 * Per-checkout switch. Backup is off for every checkout until `enable` writes this record into the
 * engine folder. The record pins the worktree's real path and the remote's fetch and push addresses
 * (as SHA-256 digests, so credentials in a URL are not copied). If any of them changes, the record no
 * longer applies and the checkout must be enabled again.
 */
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";

export interface EnablementRecord {
  schema: 1;
  realPath: string;
  remote: string;
  fetchUrlDigest: string;
  pushUrlDigest: string;
  visibilityConfirmedPublic: boolean;
  enabledAt: number;
}

export function urlDigest(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

/** Missing or malformed record: null (treated as not enabled). */
export async function readEnablement(file: string): Promise<EnablementRecord | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const hex = (x: unknown) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
  if (v.schema !== 1 || typeof v.realPath !== "string" || typeof v.remote !== "string" || !hex(v.fetchUrlDigest) || !hex(v.pushUrlDigest)) return null;
  if (typeof v.visibilityConfirmedPublic !== "boolean" || typeof v.enabledAt !== "number") return null;
  return value as EnablementRecord;
}

export async function writeEnablement(file: string, record: EnablementRecord): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

export async function removeEnablement(file: string): Promise<void> {
  await rm(file, { force: true });
}
