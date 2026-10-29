import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSameFolder, prepareRuntimeFolder, removeStaleSocket, resolveRuntimeFolder } from "./runtime-dir.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vsh-rt-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(path, res);
  });
  cleanups.push(() => new Promise<void>((res) => server.close(() => res())));
  return server;
}

describe("runtime folder path authority (review finding 1)", () => {
  test("a link followed by '..' is refused before anything is created or checked", async () => {
    const tree = root();
    mkdirSync(join(tree, "a", "b", "c"), { recursive: true, mode: 0o700 });
    mkdirSync(join(tree, "rt"), { mode: 0o700 });
    symlinkSync(join(tree, "a", "b", "c"), join(tree, "link"));
    // The filesystem reaches <tree>/rt; a lexical join would have reached a folder outside <tree>.
    await expect(prepareRuntimeFolder(`${tree}/link/../../../rt`)).rejects.toThrow("'..' segments");
    await expect(prepareRuntimeFolder(`${tree}/./rt`)).rejects.toThrow("'..' segments");
    await expect(resolveRuntimeFolder(`${tree}/link/../../../rt`)).rejects.toThrow("'..' segments");
  });

  test("every operational path is under the real folder that was checked", async () => {
    const tree = root();
    symlinkSync(tree, join(tree, "alias"));
    const paths = await prepareRuntimeFolder(join(tree, "alias", "rt"));
    expect(paths.dir).toBe(join(tree, "rt"));
    expect(paths.socket).toBe(join(tree, "rt", "helper.sock"));
    expect(paths.ownerLock).toBe(join(tree, "rt", "owner.lock"));
    const info = lstatSync(join(tree, "rt"));
    expect(paths.identity).toEqual({ dev: info.dev, ino: info.ino });
    expect(info.mode & 0o777).toBe(0o700);
  });

  test("a folder replaced after the check is noticed, and its socket is not removed", async () => {
    const tree = root();
    const paths = await prepareRuntimeFolder(join(tree, "rt"));
    renameSync(join(tree, "rt"), join(tree, "old"));
    mkdirSync(join(tree, "rt"), { mode: 0o700 });
    await listen(join(tree, "rt", "helper.sock"));
    await expect(assertSameFolder(paths)).rejects.toThrow("replaced");
    await expect(removeStaleSocket(paths)).rejects.toThrow("replaced");
    expect(existsSync(join(tree, "rt", "helper.sock"))).toBe(true);
  });
});
