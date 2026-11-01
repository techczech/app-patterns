import { afterEach, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { writeOutput } from "./cli.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

for (const mode of ["runCli", "main"]) test(`real Node preview pipe drains before ${mode} exits`, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-output-"))); dirs.push(dir);
  const entry = join(dir, "entry.mjs");
  const source = join(dir, "entry.ts");
  writeFileSync(source, `import { main, runCli } from ${JSON.stringify(join(import.meta.dir, "cli.ts"))};
const write = process.stdout.write.bind(process.stdout);
process.stdout._writableState.highWaterMark = 65536;
process.stdout.write = ((...args) => { const ok = write(...args); if (!ok) process.stderr.write("BACKPRESSURE\\n"); return ok; });
${mode === "main" ? "main(process.argv.slice(2)).then(code => process.exit(code), () => process.exit(2));" : "runCli(process.argv.slice(2));"}`);
  const built = await Bun.build({ entrypoints: [source], target: "node", format: "esm", outdir: dir, naming: "entry.mjs" });
  expect(built.success).toBe(true);
  const config = join(dir, "config.json");
  // Actual preview command, synthetic scope echoed in its answer; missing tools prevent any Git/network work.
  const include = Array.from({ length: 24000 }, (_, i) => `x${i}`);
  writeFileSync(config, JSON.stringify({ configVersion: 2, machineId: "m", tools: { git: "/nonexistent/synthetic-git", gitleaks: "/nonexistent/synthetic-gitleaks" }, vaults: [{ id: "v", path: dir, include }] }));
  const supervisor = join(dir, "supervisor.cjs");
  writeFileSync(supervisor, `const {spawn} = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(entry)}, 'preview', '--config', ${JSON.stringify(config)}, '--vault', 'v'], {stdio:['ignore','pipe','pipe']});
let chunks=[], stderr='', exit; child.stdout.on('data', c => chunks.push(c)); child.stdout.pause();
child.stderr.on('data', c => stderr += c);
child.once('exit', code => exit = code);
setTimeout(() => child.stdout.resume(), 200);
child.once('close', close => {const bytes=Buffer.concat(chunks); let answer=null; try {answer=JSON.parse(bytes.toString('utf8'));}catch{}; process.stdout.write(JSON.stringify({exit,close,stderr,bytes:bytes.length, answer}));});`);
  const run = spawnSync("/opt/homebrew/bin/node", [supervisor], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10000 });
  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout);
  console.log(JSON.stringify({ mode, bytes: result.bytes, exit: result.exit, close: result.close, backpressure: result.stderr.includes("BACKPRESSURE") }));
  expect({ exit: result.exit, close: result.close }).toEqual({ exit: 0, close: 0 });
  expect(result.stderr).toContain("BACKPRESSURE");
  expect(result.bytes).toBeGreaterThan(256 * 1024);
  expect(result.answer?.scope.include).toEqual(include);
  expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result.answer, null, 2) + "\n"));
});

test("output completes only after callback, including backpressure", async () => {
  let complete!: (error?: Error | null) => void;
  const stream = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { complete = callback; } });
  let done = false;
  const output = writeOutput(stream, "synthetic answer").then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); expect(stream.writableNeedDrain).toBe(true);
  complete(); await output; expect(done).toBe(true);
});
test("failed callback and EPIPE reject without an unhandled stream error", async () => {
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("synthetic pipe closed"), { code: "EPIPE" })); } });
  await expect(writeOutput(stream, "answer")).rejects.toMatchObject({ code: "EPIPE" });
  await new Promise(resolve => setTimeout(resolve, 0));
});
test("a synchronous writer failure rejects", async () => {
  const stream = new Writable(); stream.write = (() => { throw new Error("synthetic writer failure"); }) as typeof stream.write;
  await expect(writeOutput(stream, "answer")).rejects.toThrow("synthetic writer failure");
});
