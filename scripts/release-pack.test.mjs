import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  frameworkPeers,
  emptyManifest,
  filesFieldProblem,
  immutabilityVerdict,
  parseArgs,
  recordRelease,
  tarballFileName,
} from "./release-pack.mjs";
import { contentsDigest, missingPromisedFiles, readTarEntries, tarballManifest } from "./release-tarball.mjs";
import { tar, writeApp } from "./release-test-fixtures.mjs";

const pkg = { name: "@app-patterns/x", version: "1.0.0", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } };

describe("tarball reading", () => {
  test("reads entries from a gzipped tarball and its package.json", () => {
    const bytes = gzipSync(tar({ "package/package.json": JSON.stringify(pkg), "package/dist/index.js": "x" }));
    const entries = readTarEntries(bytes);
    expect(entries.map((e) => e.path)).toEqual(["package/package.json", "package/dist/index.js"]);
    expect(tarballManifest(entries).name).toBe("@app-patterns/x");
  });

  test("contentsDigest ignores timestamps, entry order and gzip level, not file bytes", () => {
    const files = { "package/package.json": "{}", "package/dist/a.js": "a" };
    const reordered = { "package/dist/a.js": "a", "package/package.json": "{}" };
    const base = contentsDigest(readTarEntries(gzipSync(tar(files), { level: 9 })));
    expect(contentsDigest(readTarEntries(gzipSync(tar(reordered, { mtime: 12345 }), { level: 1 })))).toBe(base);
    expect(contentsDigest(readTarEntries(tar({ ...files, "package/dist/a.js": "b" })))).not.toBe(base);
  });

  test("missingPromisedFiles names export targets absent from the tarball", () => {
    const entries = readTarEntries(tar({ "package/package.json": "{}", "package/dist/index.js": "x" }));
    expect(missingPromisedFiles(pkg, entries)).toEqual(["dist/index.d.ts"]);
    expect(missingPromisedFiles({ bin: { cli: "./dist/index.js" } }, entries)).toEqual([]);
  });
});

describe("immutabilityVerdict", () => {
  const base = { name: "@app-patterns/settings", version: "0.14.4", file: "app-patterns-settings-0.14.4.tgz", newDigest: "sha256-A" };

  test("a version never released is new", () => {
    expect(immutabilityVerdict(base)).toBe("new");
  });

  test("identical contents on disk or in the manifest keep the release", () => {
    expect(immutabilityVerdict({ ...base, existingDigest: "sha256-A" })).toBe("same");
    expect(immutabilityVerdict({ ...base, recordedDigest: "sha256-A" })).toBe("same");
  });

  test("different contents under a released version fail and ask for a bump", () => {
    expect(() => immutabilityVerdict({ ...base, existingDigest: "sha256-B" })).toThrow(
      /@app-patterns\/settings 0\.14\.4: releases\/app-patterns-settings-0\.14\.4\.tgz .*bump the version/,
    );
    expect(() => immutabilityVerdict({ ...base, recordedDigest: "sha256-B" })).toThrow(/releases\/manifest\.json/);
  });
});

describe("manifest records", () => {
  const entry = {
    name: "@app-patterns/settings",
    version: "0.14.4",
    file: "app-patterns-settings-0.14.4.tgz",
    integrity: "sha512-x",
    contentsDigest: "sha256-A",
    frameworkPeers: { "@app-patterns/commands": "^0.3.0" },
    commit: "aaa",
    commitDirty: false,
    packedAt: "2026-10-20T00:00:00.000Z",
  };

  test("records the current version and the released file", () => {
    const manifest = recordRelease(emptyManifest(), entry);
    expect(manifest.packages["@app-patterns/settings"]).toMatchObject({ version: "0.14.4", file: entry.file, commit: "aaa" });
    expect(manifest.released[entry.file]).toMatchObject({ name: "@app-patterns/settings", contentsDigest: "sha256-A" });
  });

  test("repacking identical contents keeps the original commit and time", () => {
    const first = recordRelease(emptyManifest(), entry);
    const again = recordRelease(first, { ...entry, commit: "bbb", packedAt: "2026-10-21T00:00:00.000Z" });
    expect(again.released[entry.file].commit).toBe("aaa");
    expect(again.packages["@app-patterns/settings"].packedAt).toBe(entry.packedAt);
  });
});

describe("helpers", () => {
  test("tarballFileName drops the scope", () => {
    expect(tarballFileName("@app-patterns/settings-react", "0.1.0")).toBe("app-patterns-settings-react-0.1.0.tgz");
  });

  test("frameworkPeers keeps only @app-patterns peers", () => {
    expect(frameworkPeers({ peerDependencies: { react: ">=18", "@app-patterns/settings": "^0.14.0" } })).toEqual({
      "@app-patterns/settings": "^0.14.0",
    });
  });

  test("filesFieldProblem flags a files list without dist", () => {
    expect(filesFieldProblem({ files: ["dist", "src"] })).toBeNull();
    expect(filesFieldProblem({})).toBeNull();
    expect(filesFieldProblem({ files: ["src"] })).toContain('"files" does not include "dist"');
  });

  test("parseArgs scopes --only names", () => {
    expect(parseArgs(["--only", "settings,@app-patterns/settings-react"]).only).toEqual(["@app-patterns/settings", "@app-patterns/settings-react"]);
    expect(() => parseArgs(["--bogus"])).toThrow("Unknown argument");
  });
});

describe("release validation", () => {
  const record = (file, digest) => ({ version: "0.14.4", file, integrity: "sha512-x", contentsDigest: digest });

  test("an absent manifest is the only fresh start", async () => {
    const { loadManifest } = await import("./release-pack.mjs");
    expect(loadManifest(null)).toEqual(emptyManifest());
  });

  test("a manifest without `released` is corrupt, not fresh", async () => {
    const { loadManifest } = await import("./release-pack.mjs");
    const text = JSON.stringify({ schema: 1, packages: { "@app-patterns/settings": record("app-patterns-settings-0.14.4.tgz", "sha256-A") } });
    expect(() => loadManifest(text)).toThrow(/manifest\.json is corrupt/);
  });

  test("a packages record whose file is missing from `released` is corrupt", async () => {
    const { loadManifest } = await import("./release-pack.mjs");
    const text = JSON.stringify({
      schema: 1,
      packages: { "@app-patterns/settings": record("app-patterns-settings-0.14.4.tgz", "sha256-A") },
      released: {},
    });
    expect(() => loadManifest(text)).toThrow(/manifest\.json is corrupt.*app-patterns-settings-0\.14\.4\.tgz/);
  });

  test("a packages record disagreeing with `released` is corrupt", async () => {
    const { loadManifest } = await import("./release-pack.mjs");
    const text = JSON.stringify({
      schema: 1,
      packages: { "@app-patterns/settings": record("app-patterns-settings-0.14.4.tgz", "sha256-A") },
      released: { "app-patterns-settings-0.14.4.tgz": { name: "@app-patterns/settings", ...record("app-patterns-settings-0.14.4.tgz", "sha256-B") } },
    });
    expect(() => loadManifest(text)).toThrow(/manifest\.json is corrupt/);
  });

  test("the current packages record digest is checked too", () => {
    expect(() =>
      immutabilityVerdict({
        name: "@app-patterns/settings",
        version: "0.14.4",
        file: "app-patterns-settings-0.14.4.tgz",
        newDigest: "sha256-A",
        currentDigest: "sha256-B",
      }),
    ).toThrow(/bump the version/);
  });

  test("a wildcard export target must match at least one archive file", () => {
    const entries = readTarEntries(tar({ "package/package.json": "{}", "package/dist/a.js": "x" }));
    const patterned = { exports: { "./*": "./dist/*.js", "./styles/*": "./dist/styles/*.css" } };
    expect(missingPromisedFiles(patterned, entries)).toEqual(["dist/styles/*.css (no file matches)"]);
  });

  test("a target with more than one wildcard is rejected", () => {
    const entries = readTarEntries(tar({ "package/package.json": "{}" }));
    expect(() => missingPromisedFiles({ exports: { "./*": "./dist/*/*.js" } }, entries)).toThrow(/unsupported/);
  });

  test("tarballs ship no source, tests or home-folder paths", async () => {
    const { forbiddenContents } = await import("./release-tarball.mjs");
    const entries = readTarEntries(
      tar({
        "package/package.json": "{}",
        "package/dist/index.js": "ok",
        "package/dist/index.test.js": "x",
        "package/src/index.ts": "x",
        "package/dist/paths.js": "const p = " + JSON.stringify(["", "Users", "example", "notes"].join("/")) + ";",
        "package/dist/index.js.map": JSON.stringify({ sources: ["../src/index.ts"], sourcesContent: ["x"] }),
        "package/dist/clean.js.map": JSON.stringify({ sources: ["../src/clean.ts"] }),
      }),
    );
    expect(forbiddenContents(entries)).toEqual([
      "dist/index.js.map: source map embeds sourcesContent",
      "dist/index.test.js: test file",
      "dist/paths.js: contains a macOS user-home path",
      "src/index.ts: source folder",
    ]);
  });

  test("a record missing integrity or contentsDigest is corrupt, not equal-as-undefined", async () => {
    const { loadManifest } = await import("./release-pack.mjs");
    const bare = { version: "0.14.4", file: "app-patterns-settings-0.14.4.tgz" };
    const text = JSON.stringify({
      schema: 1,
      packages: { "@app-patterns/settings": bare },
      released: { "app-patterns-settings-0.14.4.tgz": { name: "@app-patterns/settings", version: "0.14.4" } },
    });
    expect(() => loadManifest(text)).toThrow(/manifest\.json is corrupt.*has no integrity/);
    const noDigest = { ...record("app-patterns-settings-0.14.4.tgz", "sha256-A"), contentsDigest: undefined };
    const text2 = JSON.stringify({
      schema: 1,
      packages: { "@app-patterns/settings": noDigest },
      released: { "app-patterns-settings-0.14.4.tgz": { name: "@app-patterns/settings", ...noDigest } },
    });
    expect(() => loadManifest(text2)).toThrow(/manifest\.json is corrupt.*has no contentsDigest/);
  });

  test("source maps are screened by their parsed keys, and unparseable maps are refused", async () => {
    const { forbiddenContents } = await import("./release-tarball.mjs");
    const entries = readTarEntries(
      tar({
        "package/package.json": "{}",
        "package/dist/escaped.js.map": '{"sources":["a.ts"],"sources\\u0043ontent":["secret source"]}',
        "package/dist/nulls.js.map": JSON.stringify({ sources: ["a.ts"], sourcesContent: [null] }),
        "package/dist/empty.js.map": JSON.stringify({ sources: [], sourcesContent: [] }),
        "package/dist/broken.js.map": "{not json",
      }),
    );
    expect(forbiddenContents(entries)).toEqual([
      "dist/broken.js.map: source map is not valid JSON, so it cannot be checked for sourcesContent",
      "dist/escaped.js.map: source map embeds sourcesContent",
    ]);
  });

  test("readTarEntries refuses entry types it would otherwise skip", () => {
    for (const type of ["1", "2", "3", "4", "6", "K", "S"]) {
      const bytes = tar({ "package/link": "", "package/package.json": "{}" });
      bytes[156] = type.charCodeAt(0);
      expect(() => readTarEntries(bytes)).toThrow(/has type/);
    }
    const folder = tar({ "package/dist/": "", "package/package.json": "{}" });
    folder[156] = "5".charCodeAt(0);
    expect(readTarEntries(folder).map((e) => e.path)).toEqual(["package/package.json"]);
  });

  test("readTarEntries refuses non-zero data after the end-of-archive blocks", () => {
    const clean = tar({ "package/package.json": "{}" });
    expect(readTarEntries(Buffer.concat([clean, Buffer.alloc(512)]))).toHaveLength(1);
    const trailing = Buffer.concat([clean, tar({ "package/dist/hidden.js": "x" })]);
    expect(() => readTarEntries(trailing)).toThrow(/after its end-of-archive/);
    expect(() => readTarEntries(gzipSync(trailing))).toThrow(/after its end-of-archive/);
  });

  test("nested source-map sections are walked to any depth", async () => {
    const { sourceMapProblem } = await import("./release-tarball.mjs");
    // Built as text: JSON.stringify itself recurses. Deep enough to show it is not one level.
    const depth = 1000;
    const deep = '{"sections":[{"map":'.repeat(depth) + '{"sources":["a.ts"],"sourcesContent":["secret"]}' + "}]}".repeat(depth);
    expect(sourceMapProblem(Buffer.from(deep))).toBe("source map embeds sourcesContent");
    const clean = { sections: [{ map: { sections: [{ map: { sourcesContent: [null] } }] } }] };
    expect(sourceMapProblem(Buffer.from(JSON.stringify(clean)))).toBeNull();
  });

  test("truncated padding, a partial header or missing end blocks are refused", () => {
    const clean = tar({ "package/package.json": "{}" }); // header 512 + data 2 + padding 510 + end 1024
    expect(readTarEntries(clean)).toHaveLength(1);
    expect(() => readTarEntries(clean.subarray(0, 512 + 100))).toThrow(/truncated \(payload or its 512-byte padding\)/);
    const nextHeader = tar({ "package/dist/a.js": "x" }).subarray(0, 200);
    expect(() => readTarEntries(Buffer.concat([clean.subarray(0, 1024), nextHeader]))).toThrow(/ends inside a header block/);
    expect(() => readTarEntries(clean.subarray(0, 1024))).toThrow(/lacks its two end-of-archive blocks/);
    expect(() => readTarEntries(clean.subarray(0, 1024 + 512))).toThrow(/lacks its two end-of-archive blocks/);
    expect(readTarEntries(Buffer.concat([clean, Buffer.alloc(300)]))).toHaveLength(1);
  });
});

// Run the real pack CLI in an OS-temp workspace, never the real releases/.
function withPackFixture(runTest) {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "release-pack-test-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const file of ["release-pack.mjs", "release-tarball.mjs", "run-workspaces.mjs"]) {
      copyFileSync(join(repo, "scripts", file), join(root, "scripts", file));
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({
      private: true,
      workspaces: ["packages/*"],
      scripts: { build: "bun run scripts/run-workspaces.mjs build" },
    }));
    const dir = join(root, "packages", "settings");
    mkdirSync(join(dir, "dist"), { recursive: true });
    const sourcePackage = JSON.parse(readFileSync(join(repo, "packages/settings/package.json"), "utf8"));
    writeFileSync(join(dir, "build.mjs"), `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", "export const fresh = true;");
`);
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "@app-patterns/settings", version: "1.0.0", type: "module", files: sourcePackage.files,
      exports: "./dist/index.js", scripts: { build: "bun build.mjs" },
    }));
    // Packing records Git provenance; give the temp workspace its own repo.
    writeApp(root, { ".gitignore": "releases/\n" });
    const pack = () => {
      const result = spawnSync(process.execPath, ["run", "scripts/release-pack.mjs"], { cwd: root, encoding: "utf8" });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const entries = readTarEntries(readFileSync(join(root, "releases/app-patterns-settings-1.0.0.tgz")));
      return { entries, output: result.stdout + result.stderr };
    };
    runTest({ root, dir, pack });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// These spawn real build/pack/Git processes; allow for a busy developer machine.
describe("release pack build inputs", () => {
  test("a stale dist file never reaches the tarball", () => {
    withPackFixture(({ dir, pack }) => {
      writeFileSync(join(dir, "dist/stale-smoke.js"), "stale");
      const { entries } = pack();
      expect(entries.map((entry) => entry.path)).toContain("package/dist/index.js");
      expect(entries.map((entry) => entry.path)).not.toContain("package/dist/stale-smoke.js");
      expect(existsSync(join(dir, "dist/stale-smoke.js"))).toBe(false);
    });
  }, 15_000);

  test("cleaning dist never follows a symlink outside that package's dist", () => {
    withPackFixture(({ root, dir, pack }) => {
      const outside = join(root, "retained");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "keep");
      symlinkSync(outside, join(dir, "dist/linked"));
      pack();
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
      rmSync(join(dir, "dist"), { recursive: true });
      symlinkSync(outside, join(dir, "dist"));
      const { entries } = pack();
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
      expect(existsSync(join(outside, "index.js"))).toBe(false);
      expect(entries.map((entry) => entry.path)).toContain("package/dist/index.js");
    });
  }, 15_000);


});


test("tarballs refuse Windows home paths with either slash style and drive-letter case", async () => {
  const { forbiddenContents } = await import("./release-tarball.mjs");
  for (const home of [["C:", "Users", "example", ".cargo", "registry"].join("\\"), ["c:", "Users", "example", ".cargo", "registry"].join("/"), ["D:", "Users/example", ".cargo/registry"].join("\\")]) {
    expect(forbiddenContents([{ path: "package/bin/helper.exe", data: Buffer.from(home) }])).toEqual([
      "bin/helper.exe: contains a Windows user-home path",
    ]);
  }
  expect(forbiddenContents([{ path: "package/dist/index.js", data: Buffer.from("C:/Program Files/App Patterns Framework/bin") }])).toEqual([]);
});
