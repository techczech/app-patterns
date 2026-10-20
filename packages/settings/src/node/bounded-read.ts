/** Reading a small file: regular files only, size-capped, never blocking, never through a symlink. Ported from Agent Traffic Control. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** What a bounded read found: the text, no file, a file too large, or something that is not a regular file (FIFO, device, directory, symlink). */
export type BoundedRead = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "too-large" } | { kind: "not-file" } | { kind: "error" };

/**
 * Reads `path` as UTF-8 if it is a regular file of at most `cap` bytes. Opened non-blocking and without following a symlink, and checked
 * again on the open handle, so a file swapped for a FIFO or a link between the two checks cannot hang the read.
 */
export async function readBoundedFile(path: string, cap: number): Promise<BoundedRead> {
  try {
    let st;
    try {
      st = await lstat(path);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "error" };
    }
    if (!st.isFile()) return { kind: "not-file" };
    if (st.size > cap) return { kind: "too-large" };
    let fh;
    try {
      fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ELOOP" ? { kind: "not-file" } : code === "ENOENT" ? { kind: "missing" } : { kind: "error" };
    }
    try {
      const st2 = await fh.stat();
      if (!st2.isFile()) return { kind: "not-file" };
      if (st2.size > cap) return { kind: "too-large" };
      const buf = Buffer.alloc(cap + 1);
      let n = 0;
      while (n < buf.length) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
      }
      return n > cap ? { kind: "too-large" } : { kind: "ok", text: buf.subarray(0, n).toString("utf8") };
    } finally {
      await fh.close();
    }
  } catch {
    return { kind: "error" };
  }
}
