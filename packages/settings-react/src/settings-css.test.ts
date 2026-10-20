import { describe, expect, test } from "bun:test";
import { SETTINGS_CSS } from "./settings-css.ts";

describe("the stylesheet", () => {
  test("the root declares no accent variable, so one set on an ancestor is inherited; every use has a default", () => {
    const root = /\.bsw-root\{([^}]*)\}/.exec(SETTINGS_CSS)![1]!;
    expect(root).not.toMatch(/--bsw-accent/);
    expect(SETTINGS_CSS).not.toMatch(/var\(--bsw-accent(-[a-z]+)?\)/);
  });
  test("inspector values wrap instead of scrolling sideways", () => {
    expect(SETTINGS_CSS).toMatch(/\.bsw-ib\{[^}]*overflow-x:hidden/);
    expect(SETTINGS_CSS).toMatch(/\.bsw-kv b\{[^}]*overflow-wrap:anywhere/);
  });
  test("the inspector's reset button wraps a long default instead of clipping it", () => {
    expect(SETTINGS_CSS).toMatch(/\.bsw-start\{[^}]*max-width:100%[^}]*white-space:normal[^}]*overflow-wrap:anywhere/);
  });
});
