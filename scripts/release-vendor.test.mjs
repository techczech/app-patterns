import { describe, expect, test } from "bun:test";

import { frameworkClosure, planVendor, tarballSpec } from "./release-vendor.mjs";

const manifest = {
  schema: 1,
  packages: {
    "@app-patterns/commands": { version: "0.3.1", file: "app-patterns-commands-0.3.1.tgz", integrity: "sha512-c", frameworkPeers: {} },
    "@app-patterns/settings": {
      version: "0.14.4",
      file: "app-patterns-settings-0.14.4.tgz",
      integrity: "sha512-k",
      frameworkPeers: { "@app-patterns/commands": "^0.3.0" },
    },
    "@app-patterns/settings-react": {
      version: "0.2.5",
      file: "app-patterns-settings-react-0.2.5.tgz",
      integrity: "sha512-r",
      frameworkPeers: { "@app-patterns/settings": "^0.14.0" },
    },
    "@app-patterns/outline": { version: "0.1.0", file: "app-patterns-outline-0.1.0.tgz", integrity: "sha512-s", frameworkPeers: {} },
  },
  released: {},
};

function releaseOf(name) {
  const record = manifest.packages[name];
  if (!record) throw new Error(`${name} is not in the release manifest. Run release:pack in App Patterns Framework first.`);
  return { name, ...record, needs: record.frameworkPeers };
}

const rootText = `{
  "name": "app",
  "description": "An app \\u2014 with an escape",
  "files": ["out", "package.json"],
  "dependencies": {
    "@app-patterns/settings-react": "file:../../framework/packages/settings-react",
    "left-pad": "^1.0.0"
  },
  "overrides": {
    "@app-patterns/settings-react": "file:../../framework/packages/settings-react"
  }
}
`;

describe("planVendor", () => {
  test("rewrites @app-patterns deps to vendored tarballs and adds the peer closure", () => {
    const plan = planVendor({ packageJsons: [{ relPath: "package.json", text: rootText }], releaseOf });
    expect(plan.needed).toEqual(["@app-patterns/commands", "@app-patterns/settings", "@app-patterns/settings-react"]);
    expect(plan.tarballs.map((t) => t.file)).toEqual([
      "app-patterns-commands-0.3.1.tgz",
      "app-patterns-settings-0.14.4.tgz",
      "app-patterns-settings-react-0.2.5.tgz",
    ]);
    const [file] = plan.files;
    expect(file.addedPeers).toEqual(["@app-patterns/commands", "@app-patterns/settings"]);
    const json = JSON.parse(file.after);
    expect(json.dependencies).toEqual({
      "@app-patterns/commands": "file:./vendor/app-patterns/app-patterns-commands-0.3.1.tgz",
      "@app-patterns/settings": "file:./vendor/app-patterns/app-patterns-settings-0.14.4.tgz",
      "@app-patterns/settings-react": "file:./vendor/app-patterns/app-patterns-settings-react-0.2.5.tgz",
      "left-pad": "^1.0.0",
    });
    expect(Object.keys(json.overrides)).toEqual(["@app-patterns/commands", "@app-patterns/settings", "@app-patterns/settings-react"]);
    expect(Object.keys(json)).toEqual(["name", "description", "files", "dependencies", "overrides"]);
  });

  test("leaves everything except @app-patterns values byte-for-byte unchanged", () => {
    const plan = planVendor({ packageJsons: [{ relPath: "package.json", text: rootText }], releaseOf });
    const after = plan.files[0].after;
    expect(after).toContain('"description": "An app \\u2014 with an escape"');
    expect(after).toContain('"files": ["out", "package.json"]');
    expect(after.endsWith("}\n")).toBe(true);
  });

  test("creates an overrides section when the root has none", () => {
    const text = `{\n  "name": "app",\n  "dependencies": {\n    "@app-patterns/commands": "^0.3.0"\n  }\n}\n`;
    const plan = planVendor({ packageJsons: [{ relPath: "package.json", text }], releaseOf });
    expect(plan.files[0].after).toBe(
      `{\n  "name": "app",\n  "dependencies": {\n    "@app-patterns/commands": "file:./vendor/app-patterns/app-patterns-commands-0.3.1.tgz"\n  },\n` +
        `  "overrides": {\n    "@app-patterns/commands": "file:./vendor/app-patterns/app-patterns-commands-0.3.1.tgz"\n  }\n}\n`,
    );
  });

  test("workspace package.json files point at the root vendor folder and get no overrides", () => {
    const root = `{\n  "name": "app",\n  "workspaces": ["sidecar"]\n}\n`;
    const sidecar = `{\n  "name": "sidecar",\n  "dependencies": {\n    "@app-patterns/outline": "file:../../app-patterns/packages/outline"\n  }\n}\n`;
    const plan = planVendor({
      packageJsons: [
        { relPath: "package.json", text: root },
        { relPath: "sidecar/package.json", text: sidecar },
      ],
      releaseOf,
    });
    const byPath = Object.fromEntries(plan.files.map((f) => [f.relPath, JSON.parse(f.after)]));
    expect(byPath["sidecar/package.json"].dependencies["@app-patterns/outline"]).toBe(
      "file:../vendor/app-patterns/app-patterns-outline-0.1.0.tgz",
    );
    expect(byPath["sidecar/package.json"].overrides).toBeUndefined();
    expect(byPath["package.json"].overrides).toEqual({
      "@app-patterns/outline": "file:./vendor/app-patterns/app-patterns-outline-0.1.0.tgz",
    });
  });

  test("override-only names are vendored too", () => {
    const text = `{\n  "dependencies": {},\n  "overrides": {\n    "@app-patterns/outline": "file:x"\n  }\n}\n`;
    const plan = planVendor({ packageJsons: [{ relPath: "package.json", text }], releaseOf });
    expect(plan.needed).toEqual(["@app-patterns/outline"]);
  });

  test("peerDependencies keep their ranges", () => {
    const text = `{\n  "peerDependencies": {\n    "@app-patterns/settings": "^0.14.0"\n  },\n  "devDependencies": {\n    "@app-patterns/settings": "file:x"\n  }\n}\n`;
    const json = JSON.parse(planVendor({ packageJsons: [{ relPath: "package.json", text }], releaseOf }).files[0].after);
    expect(json.peerDependencies["@app-patterns/settings"]).toBe("^0.14.0");
    expect(json.devDependencies).toEqual({
      "@app-patterns/commands": "file:./vendor/app-patterns/app-patterns-commands-0.3.1.tgz",
      "@app-patterns/settings": "file:./vendor/app-patterns/app-patterns-settings-0.14.4.tgz",
    });
  });

  test("plans removal only for ledger files the app no longer uses; reports unowned ones", () => {
    const plan = planVendor({
      packageJsons: [{ relPath: "package.json", text: rootText }],
      releaseOf,
      ledger: { schema: 1, files: { "app-patterns-settings-0.14.3.tgz": { integrity: "sha512-old" }, "app-patterns-settings-0.14.4.tgz": { integrity: "sha512-k" } } },
      existingVendorFiles: ["app-patterns-settings-0.14.3.tgz", "app-patterns-settings-0.14.4.tgz", "app-patterns-hand-1.0.0.tgz", "README.md"],
    });
    expect(plan.ledgerRemovals).toEqual([{ file: "app-patterns-settings-0.14.3.tgz", integrity: "sha512-old" }]);
    expect(plan.unowned).toEqual(["app-patterns-hand-1.0.0.tgz"]);
  });

  test("is idempotent: a vendored package.json plans no changes", () => {
    const first = planVendor({ packageJsons: [{ relPath: "package.json", text: rootText }], releaseOf });
    const second = planVendor({ packageJsons: [{ relPath: "package.json", text: first.files[0].after }], releaseOf });
    expect(second.files).toEqual([]);
  });

  test("fails on a @app-patterns package the manifest does not know", () => {
    const text = `{\n  "dependencies": {\n    "@app-patterns/unknown": "^1.0.0"\n  }\n}\n`;
    expect(() => planVendor({ packageJsons: [{ relPath: "package.json", text }], releaseOf })).toThrow(
      "@app-patterns/unknown is not in the release manifest",
    );
  });
});

describe("helpers", () => {
  test("frameworkClosure follows peers transitively", () => {
    expect(frameworkClosure(["@app-patterns/settings-react"], releaseOf)).toEqual(["@app-patterns/commands", "@app-patterns/settings", "@app-patterns/settings-react"]);
  });

  test("tarballSpec is relative to the package.json", () => {
    expect(tarballSpec("package.json", "a.tgz")).toBe("file:./vendor/app-patterns/a.tgz");
    expect(tarballSpec("packages/x/package.json", "a.tgz")).toBe("file:../../vendor/app-patterns/a.tgz");
  });

});


describe("plain semver comparator sets", () => {
  for (const range of ["^0.2.0", "~0.2.0", "0.2.3", ">=0.2.0 <0.3.0", ">= 0.2.0 <= 0.2.3", "^0.1.0 || ^0.2.0"]) {
    test(`accepts ${range}`, () => {
      const releases = {
        "@app-patterns/settings-react": {
          name: "@app-patterns/settings-react", version: "0.2.0", file: "app-patterns-settings-react-0.2.0.tgz",
          needs: { "@app-patterns/outline": range },
        },
        "@app-patterns/outline": { name: "@app-patterns/outline", version: "0.2.3", file: "app-patterns-outline-0.2.3.tgz" },
      };
      const plan = planVendor({
        packageJsons: [{ relPath: "package.json", text: JSON.stringify({ dependencies: { "@app-patterns/settings-react": "file:old" } }) }],
        releaseOf: (name) => releases[name],
      });
      expect(plan.needed).toEqual(["@app-patterns/outline", "@app-patterns/settings-react"]);
    });
  }
});
