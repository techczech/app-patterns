// Scenario tests for release:vendor's write safety (release validation).
// Each test builds a throwaway releases/ folder and git app under the OS temp dir.

import { describe, expect, test } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { contentsDigest, integrity, readTarEntries } from "./release-tarball.mjs";
import { COMMANDS, SETTINGS, commitAll, packageTarball, tempDir, writeApp, writeReleases } from "./release-test-fixtures.mjs";
import { vendorApp } from "./release-vendor.mjs";

const quiet = { log: () => {} };
const appJson = (deps) => ({ name: "app", version: "1.0.0", dependencies: deps });

function setup({ releases = [COMMANDS, SETTINGS], tamper, appFiles } = {}) {
  const root = tempDir();
  const releasesDir = join(root, "a", "b", "rel");
  const manifest = writeReleases(releasesDir, releases, { tamper });
  const appRoot = join(root, "apps", "app");
  mkdirSync(appRoot, { recursive: true });
  writeApp(appRoot, appFiles ?? { "package.json": appJson({ "@app-patterns/settings": "^0.14.0" }) });
  return { root, releasesDir, appRoot, manifest };
}

describe("manifest file names cannot escape vendor/app-patterns", () => {
  test("a manifest file of ../../../escape.tgz is refused and nothing is written outside", () => {
    const { root, releasesDir, appRoot } = setup({
      tamper: (manifest) => {
        // Consistent in both records, so only the file-name check stands in the way.
        manifest.packages["@app-patterns/commands"].file = "../../../escape.tgz";
        manifest.released["../../../escape.tgz"] = manifest.released["app-patterns-commands-0.3.1.tgz"];
        delete manifest.released["app-patterns-commands-0.3.1.tgz"];
      },
    });
    // Put a real tarball where the escaping source path points, with matching integrity.
    const bytes = packageTarball(COMMANDS);
    writeFileSync(join(root, "escape.tgz"), bytes);
    const manifestPath = join(releasesDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.packages["@app-patterns/commands"].integrity = integrity(bytes);
    manifest.released["../../../escape.tgz"].integrity = integrity(bytes);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => vendorApp({ appRoot, releasesDir, write: true, ...quiet })).toThrow(/not a valid release tarball name/);
    expect(existsSync(join(root, "apps", "escape.tgz"))).toBe(false);
  });
});

describe("symlinks are refused before any change", () => {
  test("vendor/app-patterns as a symlink to a folder outside the app", () => {
    const { root, releasesDir, appRoot } = setup();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(appRoot, "vendor"));
    symlinkSync(elsewhere, join(appRoot, "vendor", "app-patterns"));
    commitAll(appRoot);
    const before = readFileSync(join(appRoot, "package.json"), "utf8");
    expect(() => vendorApp({ appRoot, releasesDir, write: true, ...quiet })).toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readFileSync(join(appRoot, "package.json"), "utf8")).toBe(before);
  });

  test("a root package.json that is a symlink to a file outside the app", () => {
    const { root, releasesDir, appRoot } = setup();
    const outside = join(root, "outside-package.json");
    const text = `${JSON.stringify(appJson({ "@app-patterns/settings": "^0.14.0" }), null, 2)}\n`;
    writeFileSync(outside, text);
    rmSync(join(appRoot, "package.json"));
    symlinkSync(outside, join(appRoot, "package.json"));
    commitAll(appRoot);
    expect(() => vendorApp({ appRoot, releasesDir, write: true, ...quiet })).toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe(text);
    expect(existsSync(join(appRoot, "vendor"))).toBe(false);
  });
});

describe("workspace package.json files must be inside the app", () => {
  test("a ../sibling workspace is refused, even in a dry run", () => {
    const { root, releasesDir, appRoot } = setup({
      appFiles: { "package.json": { name: "app", workspaces: ["../sibling"] } },
    });
    mkdirSync(join(root, "apps", "sibling"));
    const siblingText = `${JSON.stringify(appJson({ "@app-patterns/settings": "^0.14.0" }), null, 2)}\n`;
    writeFileSync(join(root, "apps", "sibling", "package.json"), siblingText);
    expect(() => vendorApp({ appRoot, releasesDir, write: false, ...quiet })).toThrow(/outside the app/);
    expect(readFileSync(join(root, "apps", "sibling", "package.json"), "utf8")).toBe(siblingText);
  });
});

describe("cleanup deletes only files the tool placed and that are unchanged", () => {
  test("a hand-placed app-patterns-*.tgz is kept and reported; no ledger means no deletions", () => {
    const { releasesDir, appRoot } = setup({
      appFiles: {
        "package.json": appJson({ "@app-patterns/settings": "^0.14.0" }),
        "vendor/app-patterns/app-patterns-handmade-1.0.0.tgz": "hand placed",
      },
    });
    const lines = [];
    vendorApp({ appRoot, releasesDir, write: true, log: (line) => lines.push(line) });
    expect(readFileSync(join(appRoot, "vendor/app-patterns/app-patterns-handmade-1.0.0.tgz"), "utf8")).toBe("hand placed");
    expect(lines.join("\n")).toMatch(/left in place.*app-patterns-handmade-1\.0\.0\.tgz|app-patterns-handmade-1\.0\.0\.tgz.*left in place/);
    const ledger = JSON.parse(readFileSync(join(appRoot, "vendor/app-patterns/vendored.json"), "utf8"));
    expect(Object.keys(ledger.files).sort()).toEqual(["app-patterns-commands-0.3.1.tgz", "app-patterns-settings-0.14.4.tgz"]);
  });

  test("a stale tarball the tool placed is deleted only while its bytes match the ledger", () => {
    const { releasesDir, appRoot } = setup({
      releases: [COMMANDS, SETTINGS, { name: "@app-patterns/settings-electron", version: "0.1.2" }, { name: "@app-patterns/outline", version: "0.1.0" }],
      appFiles: {
        "package.json": appJson({ "@app-patterns/settings": "^0.14.0", "@app-patterns/settings-electron": "^0.1.0", "@app-patterns/outline": "^0.1.0" }),
      },
    });
    vendorApp({ appRoot, releasesDir, write: true, ...quiet });
    // The app drops settings-electron and outline; someone edits the outline tarball by hand.
    writeFileSync(join(appRoot, "vendor/app-patterns/app-patterns-outline-0.1.0.tgz"), "edited by hand");
    writeFileSync(join(appRoot, "package.json"), `${JSON.stringify(appJson({ "@app-patterns/settings": "^0.14.0" }), null, 2)}\n`);
    commitAll(appRoot);
    const lines = [];
    vendorApp({ appRoot, releasesDir, write: true, log: (line) => lines.push(line) });
    expect(existsSync(join(appRoot, "vendor/app-patterns/app-patterns-settings-electron-0.1.2.tgz"))).toBe(false);
    expect(readFileSync(join(appRoot, "vendor/app-patterns/app-patterns-outline-0.1.0.tgz"), "utf8")).toBe("edited by hand");
    expect(lines.join("\n")).toMatch(/app-patterns-outline-0\.1\.0\.tgz/);
  });
});

describe("the peer closure comes from the verified archives", () => {
  test("a manifest whose frameworkPeers disagree with the archive is refused", () => {
    const { releasesDir, appRoot } = setup({
      tamper: (manifest) => {
        manifest.packages["@app-patterns/settings"].frameworkPeers = {};
      },
    });
    expect(() => vendorApp({ appRoot, releasesDir, write: false, ...quiet })).toThrow(/does not match its archive/);
  });
});

describe("the bytes written are the bytes verified", () => {
  test("a release file swapped after verification does not reach the app", () => {
    const { releasesDir, appRoot } = setup();
    const verifiedBytes = readFileSync(join(releasesDir, "app-patterns-settings-0.14.4.tgz"));
    let swapped = false;
    vendorApp({
      appRoot,
      releasesDir,
      write: true,
      ...quiet,
      afterVerify: () => {
        writeFileSync(join(releasesDir, "app-patterns-settings-0.14.4.tgz"), "swapped");
        swapped = true;
      },
    });
    expect(swapped).toBe(true);
    expect(readFileSync(join(appRoot, "vendor/app-patterns/app-patterns-settings-0.14.4.tgz")).equals(verifiedBytes)).toBe(true);
  });
});

describe("every app package.json and vendor/app-patterns must be committed", () => {
  test("an uncommitted workspace package.json the tool would not change still blocks --write", () => {
    const { releasesDir, appRoot } = setup({
      appFiles: {
        "package.json": { name: "app", workspaces: ["tools/*"], dependencies: { "@app-patterns/settings": "^0.14.0" } },
        "tools/cli/package.json": { name: "cli" },
      },
    });
    writeFileSync(join(appRoot, "tools/cli/package.json"), `{ "name": "cli", "private": true }\n`);
    const before = readFileSync(join(appRoot, "package.json"), "utf8");
    expect(() => vendorApp({ appRoot, releasesDir, write: true, ...quiet })).toThrow(/uncommitted/);
    expect(readFileSync(join(appRoot, "package.json"), "utf8")).toBe(before);
  });

  test("uncommitted files in vendor/app-patterns block --write", () => {
    const { releasesDir, appRoot } = setup();
    mkdirSync(join(appRoot, "vendor/app-patterns"), { recursive: true });
    writeFileSync(join(appRoot, "vendor/app-patterns/notes.txt"), "untracked");
    const before = readFileSync(join(appRoot, "package.json"), "utf8");
    expect(() => vendorApp({ appRoot, releasesDir, write: true, ...quiet })).toThrow(/uncommitted/);
    expect(readFileSync(join(appRoot, "package.json"), "utf8")).toBe(before);
  });
});

// Ignored vendor files exercise the untrusted-ledger case: Git status cannot see their changes.
const ignoringApp = { ".gitignore": "vendor/app-patterns/\n", "package.json": appJson({ "@app-patterns/settings": "^0.14.0" }) };

describe("writes never follow a symlink planted after verification", () => {
  test("vendored.json turned into a symlink is replaced, its target untouched", () => {
    const { root, releasesDir, appRoot } = setup({ appFiles: ignoringApp });
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "do not touch");
    vendorApp({
      appRoot,
      releasesDir,
      write: true,
      ...quiet,
      afterVerify: () => {
        mkdirSync(join(appRoot, "vendor/app-patterns"), { recursive: true });
        symlinkSync(outside, join(appRoot, "vendor/app-patterns/vendored.json"));
      },
    });
    expect(readFileSync(outside, "utf8")).toBe("do not touch");
    const ledgerPath = join(appRoot, "vendor/app-patterns/vendored.json");
    expect(lstatSync(ledgerPath).isSymbolicLink()).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(ledgerPath, "utf8")).files)).toContain("app-patterns-settings-0.14.4.tgz");
  });

  test("a tarball destination turned into a symlink is replaced, its target untouched", () => {
    const { root, releasesDir, appRoot } = setup({ appFiles: ignoringApp });
    const outside = join(root, "outside.tgz");
    writeFileSync(outside, "do not touch");
    vendorApp({
      appRoot,
      releasesDir,
      write: true,
      ...quiet,
      afterVerify: () => {
        mkdirSync(join(appRoot, "vendor/app-patterns"), { recursive: true });
        symlinkSync(outside, join(appRoot, "vendor/app-patterns/app-patterns-settings-0.14.4.tgz"));
      },
    });
    expect(readFileSync(outside, "utf8")).toBe("do not touch");
    const dest = join(appRoot, "vendor/app-patterns/app-patterns-settings-0.14.4.tgz");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest).equals(readFileSync(join(releasesDir, "app-patterns-settings-0.14.4.tgz")))).toBe(true);
    expect(readdirSync(join(appRoot, "vendor/app-patterns")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  for (const swapped of ["vendor", "vendor/app-patterns"]) {
    test(`${swapped} turned into a symlink to an outside folder is refused before any write`, () => {
      // "vendor/app-patterns/" ignores only a directory; git would report the symlink as
      // untracked and refuse first. Without the slash the symlink is ignored too,
      // so this reaches the re-check made immediately before writing.
      const { root, releasesDir, appRoot } = setup({ appFiles: { ...ignoringApp, ".gitignore": "vendor/app-patterns\n" } });
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);
      const before = readFileSync(join(appRoot, "package.json"), "utf8");
      expect(() =>
        vendorApp({
          appRoot,
          releasesDir,
          write: true,
          ...quiet,
          afterVerify: () => {
            if (swapped === "vendor/app-patterns") mkdirSync(join(appRoot, "vendor"));
            symlinkSync(elsewhere, join(appRoot, swapped));
          },
        }),
      ).toThrow(/not a plain folder/);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(readFileSync(join(appRoot, "package.json"), "utf8")).toBe(before);
    });
  }
});

describe("a ledger alone never authorises a deletion", () => {
  test("a forged ledger naming a hand-placed file with its hash, but no App Patterns Framework release, keeps the file", () => {
    const { releasesDir, appRoot } = setup({ appFiles: ignoringApp });
    const handmade = Buffer.from("hand placed");
    mkdirSync(join(appRoot, "vendor/app-patterns"), { recursive: true });
    writeFileSync(join(appRoot, "vendor/app-patterns/app-patterns-handmade-1.0.0.tgz"), handmade);
    writeFileSync(
      join(appRoot, "vendor/app-patterns/vendored.json"),
      JSON.stringify({
        schema: 1,
        files: { "app-patterns-handmade-1.0.0.tgz": { name: "@app-patterns/handmade", version: "1.0.0", integrity: integrity(handmade) } },
      }),
    );
    const lines = [];
    const result = vendorApp({ appRoot, releasesDir, write: true, log: (line) => lines.push(line) });
    expect(result.removals).toEqual([]);
    expect(readFileSync(join(appRoot, "vendor/app-patterns/app-patterns-handmade-1.0.0.tgz")).equals(handmade)).toBe(true);
    expect(lines.join("\n")).toMatch(/left in place: vendor\/app-patterns\/app-patterns-handmade-1\.0\.0\.tgz \(not byte-identical to a App Patterns Framework release/);
  });
});

describe("an existing vendored tarball is kept only on an exact byte match", () => {
  const settingsPath = (appRoot) => join(appRoot, "vendor/app-patterns/app-patterns-settings-0.14.4.tgz");
  // Same tar contents, different gzip bytes: equal contentsDigest, different integrity.
  const regzipped = (releasesDir) => gzipSync(gunzipSync(readFileSync(join(releasesDir, "app-patterns-settings-0.14.4.tgz"))), { level: 1 });

  test("same contents but different bytes, not in the ledger, are refused and left alone", () => {
    const { releasesDir, appRoot } = setup({ appFiles: ignoringApp });
    const other = regzipped(releasesDir);
    const release = readFileSync(join(releasesDir, "app-patterns-settings-0.14.4.tgz"));
    expect(other.equals(release)).toBe(false);
    expect(contentsDigest(readTarEntries(other))).toBe(contentsDigest(readTarEntries(release)));
    mkdirSync(join(appRoot, "vendor/app-patterns"), { recursive: true });
    writeFileSync(settingsPath(appRoot), other);
    expect(() => vendorApp({ appRoot, releasesDir, write: true, ...quiet })).toThrow(
      /vendor\/app-patterns\/app-patterns-settings-0\.14\.4\.tgz in the app is not App Patterns Framework's release/,
    );
    expect(readFileSync(settingsPath(appRoot)).equals(other)).toBe(true);
    expect(existsSync(join(appRoot, "vendor/app-patterns/vendored.json"))).toBe(false);
  });

  test("an older build the ledger shows we placed unchanged is replaced; the ledger records the release integrity", () => {
    const { releasesDir, appRoot } = setup({ appFiles: ignoringApp });
    const older = regzipped(releasesDir);
    const releaseIntegrity = integrity(readFileSync(join(releasesDir, "app-patterns-settings-0.14.4.tgz")));
    mkdirSync(join(appRoot, "vendor/app-patterns"), { recursive: true });
    writeFileSync(settingsPath(appRoot), older);
    writeFileSync(
      join(appRoot, "vendor/app-patterns/vendored.json"),
      JSON.stringify({
        schema: 1,
        files: { "app-patterns-settings-0.14.4.tgz": { name: "@app-patterns/settings", version: "0.14.4", integrity: integrity(older) } },
      }),
    );
    const lines = [];
    vendorApp({ appRoot, releasesDir, write: true, log: (line) => lines.push(line) });
    expect(lines.join("\n")).toMatch(/replace vendor\/app-patterns\/app-patterns-settings-0\.14\.4\.tgz/);
    expect(integrity(readFileSync(settingsPath(appRoot)))).toBe(releaseIntegrity);
    const ledger = JSON.parse(readFileSync(join(appRoot, "vendor/app-patterns/vendored.json"), "utf8"));
    expect(ledger.files["app-patterns-settings-0.14.4.tgz"].integrity).toBe(releaseIntegrity);
  });

  test("a ledger-listed tarball whose bytes changed since placement is refused", () => {
    const { releasesDir, appRoot } = setup({ appFiles: ignoringApp });
    mkdirSync(join(appRoot, "vendor/app-patterns"), { recursive: true });
    writeFileSync(settingsPath(appRoot), regzipped(releasesDir));
    writeFileSync(
      join(appRoot, "vendor/app-patterns/vendored.json"),
      JSON.stringify({
        schema: 1,
        files: { "app-patterns-settings-0.14.4.tgz": { name: "@app-patterns/settings", version: "0.14.4", integrity: "sha512-somethingelse" } },
      }),
    );
    expect(() => vendorApp({ appRoot, releasesDir, write: true, ...quiet })).toThrow(/is not App Patterns Framework's release/);
  });

  test("the exact release bytes are kept", () => {
    const { releasesDir, appRoot } = setup({ appFiles: ignoringApp });
    vendorApp({ appRoot, releasesDir, write: true, ...quiet });
    commitAll(appRoot);
    const result = vendorApp({ appRoot, releasesDir, write: true, ...quiet });
    expect(result.copies.find((c) => c.file === "app-patterns-settings-0.14.4.tgz").action).toBe("keep");
  });
});

describe("a ledger-authorised replacement re-checks the bytes at write time", () => {
  test("a listed tarball changed after verification is refused by name and nothing is written", () => {
    const { releasesDir, appRoot } = setup({ appFiles: ignoringApp });
    const settings = join(appRoot, "vendor/app-patterns/app-patterns-settings-0.14.4.tgz");
    const older = gzipSync(gunzipSync(readFileSync(join(releasesDir, "app-patterns-settings-0.14.4.tgz"))), { level: 1 });
    mkdirSync(join(appRoot, "vendor/app-patterns"), { recursive: true });
    writeFileSync(settings, older);
    const ledgerText = JSON.stringify({
      schema: 1,
      files: { "app-patterns-settings-0.14.4.tgz": { name: "@app-patterns/settings", version: "0.14.4", integrity: integrity(older) } },
    });
    writeFileSync(join(appRoot, "vendor/app-patterns/vendored.json"), ledgerText);
    const before = readFileSync(join(appRoot, "package.json"), "utf8");
    expect(() =>
      vendorApp({
        appRoot,
        releasesDir,
        write: true,
        ...quiet,
        afterVerify: () => writeFileSync(settings, "changed after verification"),
      }),
    ).toThrow(/vendor\/app-patterns\/app-patterns-settings-0\.14\.4\.tgz changed during the run/);
    expect(readFileSync(settings, "utf8")).toBe("changed after verification");
    expect(existsSync(join(appRoot, "vendor/app-patterns/app-patterns-commands-0.3.1.tgz"))).toBe(false);
    expect(readFileSync(join(appRoot, "vendor/app-patterns/vendored.json"), "utf8")).toBe(ledgerText);
    expect(readFileSync(join(appRoot, "package.json"), "utf8")).toBe(before);
  });
});


describe("App Patterns Framework peer ranges", () => {
  const settingsReact = {
    name: "@app-patterns/settings-react", version: "0.2.0",
    peerDependencies: { "@app-patterns/outline": "^0.2.0" },
  };
  for (const write of [false, true]) {
    test(`incompatible peer refuses before any write (write=${write})`, () => {
      const { root, releasesDir, appRoot } = setup({
        releases: [settingsReact, { name: "@app-patterns/outline", version: "0.1.0" }],
        appFiles: { "package.json": appJson({ "@app-patterns/settings-react": "file:old" }) },
      });
      try {
        const before = readFileSync(join(appRoot, "package.json"), "utf8");
        expect(() => vendorApp({ appRoot, releasesDir, write, ...quiet })).toThrow(
          /@app-patterns\/settings-react.*0\.2\.0.*@app-patterns\/outline.*\^0\.2\.0.*0\.1\.0/,
        );
        expect(readFileSync(join(appRoot, "package.json"), "utf8")).toBe(before);
        expect(existsSync(join(appRoot, "vendor"))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test(`regression: existing missing-peer refusal writes nothing (write=${write})`, () => {
      const { root, releasesDir, appRoot } = setup({
        releases: [settingsReact],
        appFiles: { "package.json": appJson({ "@app-patterns/settings-react": "file:old" }) },
      });
      try {
        const before = readFileSync(join(appRoot, "package.json"), "utf8");
        expect(() => vendorApp({ appRoot, releasesDir, write, ...quiet })).toThrow(
          /@app-patterns\/outline is not in the release manifest/,
        );
        expect(readFileSync(join(appRoot, "package.json"), "utf8")).toBe(before);
        expect(existsSync(join(appRoot, "vendor"))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test(`compatible peer closure succeeds (write=${write})`, () => {
      const { root, releasesDir, appRoot } = setup({
        releases: [settingsReact, { name: "@app-patterns/outline", version: "0.2.3" }],
        appFiles: { "package.json": appJson({ "@app-patterns/settings-react": "file:old" }) },
      });
      try {
        const result = vendorApp({ appRoot, releasesDir, write, ...quiet });
        expect(result.plan.needed).toEqual(["@app-patterns/outline", "@app-patterns/settings-react"]);
        expect(existsSync(join(appRoot, "vendor/app-patterns/app-patterns-outline-0.2.3.tgz"))).toBe(write);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});


describe("plain App Patterns Framework peer range syntax", () => {
  for (const write of [false, true]) {
    for (const range of ["latest", "next", "x", "", ">=", "file:../x", "npm:@app-patterns/x@^0.2.0", "^0.2.0 || garbage"]) {
      test(`invalid range ${JSON.stringify(range)} refuses without writing (write=${write})`, () => {
        const { root, releasesDir, appRoot } = setup({
          releases: [
            { name: "@app-patterns/settings-react", version: "0.2.0", peerDependencies: { "@app-patterns/outline": range } },
            { name: "@app-patterns/outline", version: "0.2.3" },
          ],
          appFiles: { "package.json": appJson({ "@app-patterns/settings-react": "file:old" }) },
        });
        try {
          const before = readFileSync(join(appRoot, "package.json"), "utf8");
          expect(() => vendorApp({ appRoot, releasesDir, write, ...quiet })).toThrow(
            `@app-patterns/settings-react 0.2.0 has invalid @app-patterns/outline peer range ${JSON.stringify(range)}`,
          );
          expect(readFileSync(join(appRoot, "package.json"), "utf8")).toBe(before);
          expect(existsSync(join(appRoot, "vendor"))).toBe(false);
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
    }

    test(`prerelease peer range is accepted (write=${write})`, () => {
      const { root, releasesDir, appRoot } = setup({
        releases: [
          { name: "@app-patterns/settings-react", version: "0.2.0", peerDependencies: { "@app-patterns/outline": "^0.2.0-rc.1" } },
          { name: "@app-patterns/outline", version: "0.2.0-rc.2" },
        ],
        appFiles: { "package.json": appJson({ "@app-patterns/settings-react": "file:old" }) },
      });
      try {
        const result = vendorApp({ appRoot, releasesDir, write, ...quiet });
        expect(result.plan.needed).toEqual(["@app-patterns/outline", "@app-patterns/settings-react"]);
        expect(existsSync(join(appRoot, "vendor/app-patterns/app-patterns-outline-0.2.0-rc.2.tgz"))).toBe(write);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});


test('a Settings-only app vendors successfully without optional updates tarballs', () => {
  const optionalSettings = {
    ...SETTINGS,
    peerDependencies: { ...SETTINGS.peerDependencies, '@app-patterns/updates': '^0.4.0', '@app-patterns/updates-react': '^0.4.0' },
    peerDependenciesMeta: { '@app-patterns/updates': { optional: true }, '@app-patterns/updates-react': { optional: true } },
  };
  const { releasesDir, appRoot } = setup({
    releases: [COMMANDS, optionalSettings],
    tamper: manifest => {
      manifest.packages[SETTINGS.name].frameworkPeers = { ...SETTINGS.peerDependencies };
      manifest.released['app-patterns-settings-0.14.4.tgz'].frameworkPeers = { ...SETTINGS.peerDependencies };
    },
  });
  vendorApp({ appRoot, releasesDir, write: true, ...quiet });
  const app = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
  expect(Object.keys(app.dependencies).sort()).toEqual(['@app-patterns/commands', '@app-patterns/settings']);
  expect(readdirSync(join(appRoot, 'vendor/app-patterns')).some(name => name.includes('updates'))).toBe(false);
});
