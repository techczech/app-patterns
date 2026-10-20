import { describe, expect, test } from "bun:test";

import { lineDiff, setSectionString } from "./release-json-edit.mjs";

describe("setSectionString", () => {
  test("refuses a section with duplicate keys", () => {
    const text = `{\n  "dependencies": {\n    "@app-patterns/settings": "a",\n    "@app-patterns/settings": "b"\n  }\n}\n`;
    expect(() => setSectionString(text, "dependencies", "@app-patterns/settings", "c")).toThrow(/duplicate key "@app-patterns\/settings"/);
  });

  test("refuses a document with duplicate top-level keys", () => {
    const text = `{\n  "overrides": {},\n  "overrides": {}\n}\n`;
    expect(() => setSectionString(text, "overrides", "@app-patterns/settings", "c")).toThrow(/duplicate key "overrides"/);
  });

  test("an empty-string duplicate key is caught and does not mask a later duplicate", () => {
    const text = `{\n  "dependencies": {\n    "": "a",\n    "": "b",\n    "@app-patterns/settings": "a",\n    "@app-patterns/settings": "b"\n  }\n}\n`;
    expect(() => setSectionString(text, "dependencies", "@app-patterns/settings", "c")).toThrow(/duplicate key "" in "dependencies"/);
    const top = `{\n  "": 1,\n  "": 2\n}\n`;
    expect(() => setSectionString(top, "dependencies", "@app-patterns/settings", "c")).toThrow(/duplicate key ""/);
  });

  test("keeps CRLF line endings when inserting", () => {
    const text = `{\r\n  "name": "app",\r\n  "dependencies": {\r\n    "a": "1"\r\n  }\r\n}\r\n`;
    const withMember = setSectionString(text, "dependencies", "z", "2");
    expect(withMember).toBe(`{\r\n  "name": "app",\r\n  "dependencies": {\r\n    "a": "1",\r\n    "z": "2"\r\n  }\r\n}\r\n`);
    const withSection = setSectionString(text, "overrides", "z", "2");
    expect(withSection.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("appends to an unsorted section and keeps tab indentation", () => {
    const text = `{\n\t"dependencies": {\n\t\t"z": "1",\n\t\t"a": "1"\n\t}\n}`;
    expect(setSectionString(text, "dependencies", "@app-patterns/settings", "v")).toBe(
      `{\n\t"dependencies": {\n\t\t"z": "1",\n\t\t"a": "1",\n\t\t"@app-patterns/settings": "v"\n\t}\n}`,
    );
  });
});

test("lineDiff marks removed then added lines", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual(["  a", "- b", "+ B", "  c"]);
});
