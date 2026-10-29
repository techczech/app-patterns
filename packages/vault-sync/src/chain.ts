/**
 * A checkout's snapshot chain is extended or published only if this engine made all of it. Every commit
 * reachable from the tip must:
 * - have at most one parent;
 * - carry the engine's identity as author and committer, and a snapshot message of this format
 *   (snapshot-message.ts) for this machine and checkout;
 * - descend from a root commit this engine recorded here when it made it (`chain.json`).
 * The recorded root is what keeps a commit message from vouching for itself: a chain from an older engine
 * version (whose snapshots had the user's HEAD as a parent), or anything else placed under the backup
 * branch, fails, and backup stops with "unsupported-history". Nothing is rewritten or deleted.
 *
 * Checked commits are content-addressed, so the newest checked tip is kept in `chain.json` and later
 * checks walk only the commits above it.
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomic, type EngineFolder } from "./engine-store.ts";
import { splitNul, type GitRunner, type GitRunOptions } from "./git-process.ts";
import { parseSnapshotMessage } from "./snapshot-message.ts";

/** A longer walk is refused rather than read without bound. */
const MAX_WALK = 100_000;

interface ChainFile {
  schema: 1;
  roots: string[];
  checked: string | null;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

async function readChain(folder: EngineFolder): Promise<ChainFile> {
  try {
    const v = JSON.parse(await readFile(folder.chainFile, "utf8")) as Partial<ChainFile>;
    if (v.schema === 1 && Array.isArray(v.roots) && v.roots.every((r) => typeof r === "string" && OID.test(r)) && (v.checked === null || (typeof v.checked === "string" && OID.test(v.checked)))) {
      return { schema: 1, roots: v.roots, checked: v.checked };
    }
  } catch { /* missing or unreadable: no roots */ }
  return { schema: 1, roots: [], checked: null };
}

/** Records a root commit this engine just made, before any ref points at it. */
export async function recordRoot(folder: EngineFolder, oid: string): Promise<void> {
  const chain = await readChain(folder);
  if (!chain.roots.includes(oid)) await writeJsonAtomic(folder.chainFile, { ...chain, roots: [...chain.roots, oid] });
}

export interface ChainIdentity {
  email: string;
  machineId: string;
  checkoutId: string;
}

/** Null when the chain ending at `tip` is entirely this engine's; otherwise why it is not. The caller holds the operation lock. */
export async function chainProblem(git: GitRunner, run: GitRunOptions, folder: EngineFolder, tip: string, who: ChainIdentity): Promise<string | null> {
  const chain = await readChain(folder);
  const roots = new Set(chain.roots);
  const walk = async (exclude: string | null) => git.run(
    ["log", "-z", "--no-color", "--no-show-signature", `--max-count=${MAX_WALK + 1}`, "--format=%H%x1f%P%x1f%ae%x1f%ce%x1f%B", "--stdin"],
    { ...run, input: Buffer.from(exclude ? `${tip}\n^${exclude}\n` : `${tip}\n`, "utf8") },
  );
  let out = await walk(chain.checked);
  // The checked tip may no longer exist here; then walk everything.
  if (out.code !== 0 && chain.checked) out = await walk(null);
  if (out.code !== 0) return "the backup history could not be read";
  const records = splitNul(out.stdout).map((r) => r.replace(/^\n/, ""));
  if (records.length > MAX_WALK) return "the backup history is too long to check";
  for (const record of records) {
    const [oid, parents, author, committer, ...body] = record.split("\x1f");
    if (!oid || !OID.test(oid)) return "the backup history could not be read";
    const parentList = (parents ?? "").split(" ").filter(Boolean);
    if (parentList.length > 1) return "the backup history contains a merge, which this engine never makes";
    if (author !== who.email || committer !== who.email) return "the backup history contains commits this engine did not make (for example the repository's own history, from an older version)";
    const parsed = parseSnapshotMessage(body.join("\x1f"));
    if (!parsed || parsed.machineId !== who.machineId || parsed.checkoutId !== who.checkoutId) return "the backup history contains commits that are not snapshots of this checkout in the current format";
    if (parentList.length === 0 && !roots.has(oid)) return "the backup history starts from a commit this engine did not record making here";
  }
  if (records.length > 0 && chain.checked !== tip) await writeJsonAtomic(folder.chainFile, { ...chain, checked: tip });
  return null;
}
