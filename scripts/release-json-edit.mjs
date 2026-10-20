// Format-preserving edits to a JSON document such as package.json.
// Parses the text into a tree that remembers where every key and value sits,
// so a change replaces only the characters it has to: key order, indentation,
// escapes such as "—", inline arrays and the trailing newline stay as the
// author wrote them.

function fail(text, index, message) {
  throw new Error(`JSON parse error at offset ${index}: ${message} (near ${JSON.stringify(text.slice(index, index + 20))})`);
}

export function parseJsonWithSpans(text) {
  let index = 0;
  const skipWhitespace = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    index += 1;
    while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
    if (index >= text.length) fail(text, start, "unterminated string");
    index += 1;
    return { type: "string", start, end: index, value: JSON.parse(text.slice(start, index)) };
  };
  const parseValue = () => {
    skipWhitespace();
    const char = text[index];
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === '"') return parseString();
    const start = index;
    const match = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(index));
    if (!match) fail(text, index, "unexpected token");
    index += match[0].length;
    return { type: "literal", start, end: index, value: JSON.parse(match[0]) };
  };
  const parseObject = () => {
    const start = index;
    index += 1;
    const members = [];
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return { type: "object", start, end: index, members };
    }
    for (;;) {
      skipWhitespace();
      if (text[index] !== '"') fail(text, index, "expected a key");
      const key = parseString();
      skipWhitespace();
      if (text[index] !== ":") fail(text, index, "expected ':'");
      index += 1;
      const value = parseValue();
      members.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value });
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return { type: "object", start, end: index, members };
      }
      fail(text, index, "expected ',' or '}'");
    }
  };
  const parseArray = () => {
    const start = index;
    index += 1;
    const items = [];
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return { type: "array", start, end: index, items };
    }
    for (;;) {
      items.push(parseValue());
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return { type: "array", start, end: index, items };
      }
      fail(text, index, "expected ',' or ']'");
    }
  };
  const tree = parseValue();
  skipWhitespace();
  if (index !== text.length) fail(text, index, "trailing content");
  return tree;
}

function lineIndentAt(text, position) {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))[0];
}

function indentUnit(text, root) {
  const first = root.members[0];
  if (!first) return "  ";
  const indent = lineIndentAt(text, first.keyStart);
  return indent === "" ? "  " : indent;
}

function separator(text, member) {
  if (!member) return ": ";
  return text.slice(member.keyEnd, member.value.start);
}

function isSorted(keys) {
  return keys.every((key, i) => i === 0 || keys[i - 1] <= key);
}

function duplicateKey(object) {
  const seen = new Set();
  for (const member of object.members) {
    if (seen.has(member.key)) return member.key;
    seen.add(member.key);
  }
  return null;
}

/**
 * Throws if the top-level object, or any of the named top-level sections, has
 * a key twice. JSON.parse keeps the last value silently, so an edit could
 * change one entry while installers read the other.
 */
export function assertNoDuplicateKeys(text, sections, label = "package.json") {
  const root = typeof text === "string" ? parseJsonWithSpans(text) : text;
  if (root.type !== "object") throw new Error(`${label} is not a JSON object`);
  const top = duplicateKey(root);
  if (top !== null) throw new Error(`${label} has a duplicate key "${top}"; fix it by hand first.`);
  for (const member of root.members) {
    if (!sections.includes(member.key) || member.value.type !== "object") continue;
    const inner = duplicateKey(member.value);
    if (inner !== null) throw new Error(`${label} has a duplicate key "${inner}" in "${member.key}"; fix it by hand first.`);
  }
  return root;
}

function splice(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}

/**
 * Sets text-level `section[key] = value` (a string) in a top-level object
 * section, creating the section at the end of the document when absent.
 * New keys go in sorted position when the section's keys are already sorted,
 * otherwise at the end. Returns the new text.
 */
export function setSectionString(text, section, key, value) {
  const root = assertNoDuplicateKeys(text, [section]);
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = indentUnit(text, root);
  const sep = separator(text, root.members[0]);
  const entry = `${JSON.stringify(key)}${sep}${JSON.stringify(value)}`;
  const sectionMember = root.members.find((m) => m.key === section);

  if (!sectionMember) {
    const block = `${JSON.stringify(section)}${sep}{${nl}${unit}${unit}${entry}${nl}${unit}}`;
    const last = root.members.at(-1);
    if (!last) return splice(text, root.start, root.end, `{${nl}${unit}${block}${nl}}`);
    return splice(text, last.value.end, last.value.end, `,${nl}${unit}${block}`);
  }

  const object = sectionMember.value;
  if (object.type !== "object") throw new Error(`"${section}" is not an object`);
  const existing = object.members.find((m) => m.key === key);
  if (existing) {
    if (existing.value.type === "string" && existing.value.value === value) return text;
    return splice(text, existing.value.start, existing.value.end, JSON.stringify(value));
  }
  if (object.members.length === 0) {
    const outer = lineIndentAt(text, sectionMember.keyStart);
    return splice(text, object.start, object.end, `{${nl}${outer}${unit}${entry}${nl}${outer}}`);
  }
  const memberIndent = lineIndentAt(text, object.members[0].keyStart);
  const keys = object.members.map((m) => m.key);
  const before = isSorted(keys) ? object.members.find((m) => m.key > key) : undefined;
  if (before) return splice(text, before.keyStart, before.keyStart, `${entry},${nl}${memberIndent}`);
  const last = object.members.at(-1);
  return splice(text, last.value.end, last.value.end, `,${nl}${memberIndent}${entry}`);
}

/** Line diff for display: returns lines prefixed with "  ", "- " or "+ ", changed regions with context. */
export function lineDiff(before, after, context = 1) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push(["  ", a[i]]);
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push(["- ", a[i]]);
      i += 1;
    } else {
      ops.push(["+ ", b[j]]);
      j += 1;
    }
  }
  const keep = ops.map(([tag], k) =>
    ops.slice(Math.max(0, k - context), k + context + 1).some(([t]) => t !== "  ") || tag !== "  ",
  );
  const out = [];
  ops.forEach(([tag, line], k) => {
    if (keep[k]) out.push(`${tag}${line}`);
    else if (keep[k - 1]) out.push("  ...");
  });
  return out;
}
