import { describe, expect, test } from "bun:test";

import {
  collectYoungPackages,
  extractRegistryPackages,
  npmViewArguments,
} from "./lock-age-check.mjs";

describe("lock-age-check", () => {
  test("routes npm metadata queries through the supplied cache", () => {
    expect(npmViewArguments("@scope/pkg", "/tmp/npm-cache")).toEqual([
      "view",
      "@scope/pkg",
      "time",
      "--json",
      "--cache",
      "/tmp/npm-cache",
    ]);
  });

  test("extracts and deduplicates registry resolutions from a Bun text lock", () => {
    const lock = `
      "packages": {
        "plain": ["plain@1.2.3", "", {}, "sha512-one"],
        "@scope/pkg": ["@scope/pkg@4.5.6", "", {}, "sha512-two"],
        "nested/plain": ["plain@1.2.3", "", {}, "sha512-one"],
        "local": ["local@file:../local", { "dependencies": {} }],
        "workspace": ["workspace@workspace:packages/workspace"],
      }
    `;

    expect(extractRegistryPackages(lock)).toEqual([
      { name: "@scope/pkg", version: "4.5.6" },
      { name: "plain", version: "1.2.3" },
    ]);
  });

  test("reports only releases younger than the configured age", () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const packages = [
      { name: "new-package", version: "2.0.0" },
      { name: "old-package", version: "1.0.0" },
    ];
    const publishTimes = new Map([
      ["new-package", { "2.0.0": "2026-07-31T12:00:00.000Z" }],
      ["old-package", { "1.0.0": "2026-07-01T12:00:00.000Z" }],
    ]);

    expect(collectYoungPackages(packages, publishTimes, 7, now)).toEqual([
      {
        name: "new-package",
        version: "2.0.0",
        published: "2026-07-31T12:00:00.000Z",
        ageDays: 1,
      },
    ]);
  });

  test("rejects a registry resolution whose publish time is absent", () => {
    expect(() =>
      collectYoungPackages(
        [{ name: "missing", version: "1.0.0" }],
        new Map([["missing", {}]]),
        7,
        new Date("2026-08-01T12:00:00.000Z"),
      ),
    ).toThrow("npm did not return a publish time for missing@1.0.0");
  });
});
