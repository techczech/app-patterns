import type { OutlineNodeKind, OutlineRange } from "./types.ts";

interface SourceLine {
  text: string;
  from: number;
  to: number;
  toWithBreak: number;
}

interface Heading {
  line: number;
  endLine: number;
  level: number;
  style: "atx" | "setext";
}

interface ListMarker {
  indent: number;
  prefixLength: number;
}

export interface ParsedMarkdown {
  text: string;
  lines: SourceLine[];
  frontmatterEnd: number;
  fenced: boolean[];
  headings: Map<number, Heading>;
}

export interface LineBlock {
  startLine: number;
  endLine: number;
  kind: OutlineNodeKind;
  level: number;
}

function sourceLines(text: string): SourceLine[] {
  const raw = text.split("\n");
  let offset = 0;
  return raw.map((line, index) => {
    const from = offset;
    const to = from + line.length;
    const toWithBreak = index < raw.length - 1 ? to + 1 : to;
    offset = toWithBreak;
    return { text: line, from, to, toWithBreak };
  });
}

function findFrontmatterEnd(lines: SourceLine[]): number {
  if (lines[0]?.text.trim() !== "---") return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.text.trim() === "---") return index;
  }
  return -1;
}

function fenceFlags(lines: SourceLine[], bodyStart: number): boolean[] {
  const result = Array.from({ length: lines.length }, () => false);
  let marker: "`" | "~" | null = null;
  let length = 0;

  for (let index = bodyStart; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? "";
    if (marker === null) {
      const open = text.match(/^ {0,3}(`{3,}|~{3,})/);
      if (!open?.[1]) continue;
      marker = open[1][0] as "`" | "~";
      length = open[1].length;
      result[index] = true;
      continue;
    }

    result[index] = true;
    const close = text.match(/^ {0,3}(`+|~+)[ \t]*$/)?.[1];
    if (close && close[0] === marker && close.length >= length) {
      marker = null;
      length = 0;
    }
  }
  return result;
}

function atxLevel(text: string): number {
  return text.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)/)?.[1]?.length ?? 0;
}

function setextLevel(text: string): number {
  const marker = text.match(/^ {0,3}(=+|-+)[ \t]*$/)?.[1];
  if (!marker) return 0;
  return marker[0] === "=" ? 1 : 2;
}

function collectHeadings(
  lines: SourceLine[],
  fenced: boolean[],
  bodyStart: number,
): Map<number, Heading> {
  const headings = new Map<number, Heading>();
  for (let index = bodyStart; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    const text = lines[index]?.text ?? "";
    const atx = atxLevel(text);
    if (atx > 0) {
      headings.set(index, { line: index, endLine: index + 1, level: atx, style: "atx" });
      continue;
    }
    if (
      index + 1 >= lines.length ||
      fenced[index + 1] ||
      !isPlainLine(lines, bodyStart - 1, fenced, headings, index)
    ) {
      continue;
    }
    const setext = setextLevel(lines[index + 1]?.text ?? "");
    if (setext > 0) {
      headings.set(index, {
        line: index,
        endLine: index + 2,
        level: setext,
        style: "setext",
      });
      index += 1;
    }
  }
  return headings;
}

export function parseMarkdown(text: string): ParsedMarkdown {
  const lines = sourceLines(text);
  const frontmatterEnd = findFrontmatterEnd(lines);
  const bodyStart = frontmatterEnd + 1;
  const fenced = fenceFlags(lines, bodyStart);
  const headings = collectHeadings(lines, fenced, bodyStart);
  return { text, lines, frontmatterEnd, fenced, headings };
}

export function lineAtPosition(parsed: ParsedMarkdown, position: number): number {
  const bounded = Math.max(0, Math.min(position, parsed.text.length));
  for (let index = 0; index < parsed.lines.length; index += 1) {
    if (bounded <= (parsed.lines[index]?.to ?? 0)) return index;
  }
  return Math.max(0, parsed.lines.length - 1);
}

function headingFromMap(headings: Map<number, Heading>, line: number): Heading | null {
  const direct = headings.get(line);
  if (direct) return direct;
  const previous = headings.get(line - 1);
  return previous?.endLine === line + 1 ? previous : null;
}

export function headingAtLine(parsed: ParsedMarkdown, line: number): Heading | null {
  return headingFromMap(parsed.headings, line);
}

function indentationWidth(text: string): number {
  let width = 0;
  for (const character of text.match(/^[ \t]*/)?.[0] ?? "") {
    width += character === "\t" ? 4 - (width % 4) : 1;
  }
  return width;
}

export function listMarker(text: string): ListMarker | null {
  const match = text.match(/^([ \t]*)(?:[-+*]|\d+[.)])([ \t]+)/);
  if (!match) return null;
  return {
    indent: indentationWidth(match[1] ?? ""),
    prefixLength: (match[1]?.length ?? 0) + match[0].length - (match[1]?.length ?? 0),
  };
}

function lineIsBlank(parsed: ParsedMarkdown, line: number): boolean {
  return (parsed.lines[line]?.text ?? "").trim() === "";
}

function isPlainLine(
  lines: SourceLine[],
  frontmatterEnd: number,
  fenced: boolean[],
  headings: Map<number, Heading>,
  line: number,
): boolean {
  return (
    line > frontmatterEnd &&
    (lines[line]?.text ?? "").trim() !== "" &&
    !fenced[line] &&
    !headingFromMap(headings, line) &&
    !listMarker(lines[line]?.text ?? "")
  );
}

function fenceBlock(parsed: ParsedMarkdown, line: number): LineBlock | null {
  if (!parsed.fenced[line]) return null;
  let startLine = line;
  let endLine = line + 1;
  while (startLine > 0 && parsed.fenced[startLine - 1]) startLine -= 1;
  while (endLine < parsed.lines.length && parsed.fenced[endLine]) endLine += 1;
  return { startLine, endLine, kind: "paragraph", level: 0 };
}

function headingBlock(parsed: ParsedMarkdown, heading: Heading): LineBlock {
  let endLine = parsed.lines.length;
  for (const candidate of parsed.headings.values()) {
    if (candidate.line > heading.line && candidate.level <= heading.level) {
      endLine = candidate.line;
      break;
    }
  }
  return {
    startLine: heading.line,
    endLine,
    kind: "heading",
    level: heading.level,
  };
}

function listBlock(parsed: ParsedMarkdown, line: number, marker: ListMarker): LineBlock {
  let endLine = line + 1;
  while (endLine < parsed.lines.length) {
    if (parsed.headings.has(endLine) || lineIsBlank(parsed, endLine)) break;
    const nextMarker = listMarker(parsed.lines[endLine]?.text ?? "");
    const indent = nextMarker?.indent ?? indentationWidth(parsed.lines[endLine]?.text ?? "");
    if (indent <= marker.indent) break;
    endLine += 1;
  }
  return {
    startLine: line,
    endLine,
    kind: "list",
    level: marker.indent,
  };
}

function paragraphBlock(parsed: ParsedMarkdown, line: number): LineBlock {
  if (lineIsBlank(parsed, line)) {
    return { startLine: line, endLine: line + 1, kind: "paragraph", level: 0 };
  }
  let startLine = line;
  let endLine = line + 1;
  const isPlain = (candidate: number): boolean =>
    isPlainLine(
      parsed.lines,
      parsed.frontmatterEnd,
      parsed.fenced,
      parsed.headings,
      candidate,
    );
  while (isPlain(startLine - 1)) startLine -= 1;
  while (isPlain(endLine)) endLine += 1;
  return { startLine, endLine, kind: "paragraph", level: 0 };
}

export function nodeBlockAtLine(parsed: ParsedMarkdown, line: number): LineBlock {
  const fence = fenceBlock(parsed, line);
  if (fence) return fence;
  const heading = headingAtLine(parsed, line);
  if (heading) return headingBlock(parsed, heading);
  const marker = listMarker(parsed.lines[line]?.text ?? "");
  if (marker) return listBlock(parsed, line, marker);
  for (let candidate = line - 1; candidate > parsed.frontmatterEnd; candidate -= 1) {
    if (lineIsBlank(parsed, candidate) || parsed.headings.has(candidate)) break;
    const parentMarker = listMarker(parsed.lines[candidate]?.text ?? "");
    if (!parentMarker) continue;
    const parent = listBlock(parsed, candidate, parentMarker);
    if (parent.endLine > line) return parent;
  }
  return paragraphBlock(parsed, line);
}

export function blockToRange(parsed: ParsedMarkdown, block: LineBlock): OutlineRange {
  const first = parsed.lines[block.startLine];
  const after = parsed.lines[block.endLine];
  const last = parsed.lines[block.endLine - 1];
  const endsBeforeBlank = after?.text.trim() === "";
  return {
    from: first?.from ?? parsed.text.length,
    to: endsBeforeBlank ? (last?.to ?? parsed.text.length) : (after?.from ?? parsed.text.length),
    kind: block.kind,
    level: block.level,
  };
}

export function getNodeRange(text: string, position: number): OutlineRange {
  const parsed = parseMarkdown(text);
  const line = lineAtPosition(parsed, position);
  return blockToRange(parsed, nodeBlockAtLine(parsed, line));
}

export function sectionBlockAtLine(parsed: ParsedMarkdown, line: number): LineBlock | null {
  if (line <= parsed.frontmatterEnd) return null;
  const direct = headingAtLine(parsed, line);
  if (direct) return headingBlock(parsed, direct);
  let containing: Heading | null = null;
  for (const heading of parsed.headings.values()) {
    if (heading.line > line) break;
    if (!containing || heading.level <= containing.level || heading.line > containing.line) {
      containing = heading;
    }
  }
  if (!containing) return null;
  return headingBlock(parsed, containing);
}

export function getSectionRange(text: string, position: number): OutlineRange | null {
  const parsed = parseMarkdown(text);
  const line = lineAtPosition(parsed, position);
  const block = sectionBlockAtLine(parsed, line);
  return block ? blockToRange(parsed, block) : null;
}
