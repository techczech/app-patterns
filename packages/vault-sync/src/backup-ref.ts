/**
 * Backup branch naming: refs/heads/backup/<machine-id>/<checkout-id>/<yyyy-mm-dd> (UTC date).
 * One checkout writes one chain; a new day's branch starts from the previous day's last snapshot.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateId(kind: string, value: string): string {
  if (typeof value !== "string" || !ID.test(value) || value.includes("..") || value.endsWith(".lock") || value.endsWith(".")) {
    throw new Error(`${kind} must be 1-64 characters of letters, digits, '.', '_' or '-', starting with a letter or digit`);
  }
  return value;
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function backupPrefix(machineId: string, checkoutId: string): string {
  return `refs/heads/backup/${validateId("machine id", machineId)}/${validateId("checkout id", checkoutId)}/`;
}

export function backupRef(machineId: string, checkoutId: string, ms: number): string {
  return `${backupPrefix(machineId, checkoutId)}${utcDate(ms)}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Picks the newest day branch from `for-each-ref` lines of "<oid> <refname>". */
export function latestDayRef(lines: readonly string[], prefix: string): { ref: string; oid: string } | null {
  let best: { ref: string; oid: string } | null = null;
  for (const line of lines) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const oid = line.slice(0, space);
    const ref = line.slice(space + 1);
    if (!ref.startsWith(prefix) || !DAY.test(ref.slice(prefix.length))) continue;
    if (!best || ref > best.ref) best = { ref, oid };
  }
  return best;
}
