import { EditorSelection, type ChangeSpec, type StateCommand } from "@codemirror/state";
import {
  blockToRange,
  headingAtLine,
  lineAtPosition,
  listMarker,
  nodeBlockAtLine,
  parseMarkdown,
  sectionBlockAtLine,
  type LineBlock,
  type ParsedMarkdown,
} from "./ranges.ts";

type Direction = "up" | "down";
type LevelDelta = -1 | 1;
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
type StateCommandTarget = Parameters<StateCommand>[0];

function minimalChange(oldText: string, newText: string): { from: number; to: number; insert: string } {
  let from = 0;
  const sharedLength = Math.min(oldText.length, newText.length);
  while (from < sharedLength && oldText.charCodeAt(from) === newText.charCodeAt(from)) from += 1;
  let oldTo = oldText.length;
  let newTo = newText.length;
  while (
    oldTo > from &&
    newTo > from &&
    oldText.charCodeAt(oldTo - 1) === newText.charCodeAt(newTo - 1)
  ) {
    oldTo -= 1;
    newTo -= 1;
  }
  return { from, to: oldTo, insert: newText.slice(from, newTo) };
}

function lineOffset(lines: string[], line: number): number {
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return offset;
}

function dispatchText(
  target: StateCommandTarget,
  newText: string,
  selection?: { anchor: number; head?: number },
  userEvent?: string,
): boolean {
  const oldText = target.state.doc.toString();
  if (newText === oldText && !selection) return true;
  const change = minimalChange(oldText, newText);
  target.dispatch(target.state.update({
    changes: newText === oldText ? undefined : change,
    selection: selection
      ? EditorSelection.single(selection.anchor, selection.head ?? selection.anchor)
      : undefined,
    userEvent,
    scrollIntoView: true,
  }));
  return true;
}

function isBlank(parsed: ParsedMarkdown, line: number): boolean {
  return (parsed.lines[line]?.text ?? "").trim() === "";
}

function trimTrailingBlanks(parsed: ParsedMarkdown, block: LineBlock): LineBlock {
  let endLine = block.endLine;
  while (endLine > block.startLine + 1 && isBlank(parsed, endLine - 1)) endLine -= 1;
  return { ...block, endLine };
}

function isolatedBlockAtLine(parsed: ParsedMarkdown, line: number): LineBlock {
  const heading = headingAtLine(parsed, line);
  if (heading) {
    return {
      startLine: heading.line,
      endLine: heading.endLine,
      kind: "heading",
      level: heading.level,
    };
  }
  const block = trimTrailingBlanks(parsed, nodeBlockAtLine(parsed, line));
  if (block.kind === "list") return { ...block, endLine: block.startLine + 1 };
  return block;
}

function adjacentListItem(
  parsed: ParsedMarkdown,
  current: LineBlock,
  direction: Direction,
): LineBlock | null {
  const step = direction === "up" ? -1 : 1;
  for (
    let line = direction === "up" ? current.startLine - 1 : current.endLine;
    line > parsed.frontmatterEnd && line < parsed.lines.length;
    line += step
  ) {
    if (isBlank(parsed, line) || parsed.fenced[line] || headingAtLine(parsed, line)) return null;
    const marker = listMarker(parsed.lines[line]?.text ?? "");
    if (marker) return { startLine: line, endLine: line + 1, kind: "list", level: marker.indent };
  }
  return null;
}

function adjacentBlock(
  parsed: ParsedMarkdown,
  current: LineBlock,
  direction: Direction,
): LineBlock | null {
  if (current.kind === "list") return adjacentListItem(parsed, current, direction);
  let line = direction === "up" ? current.startLine - 1 : current.endLine;
  while (line > parsed.frontmatterEnd && line < parsed.lines.length && isBlank(parsed, line)) {
    line += direction === "up" ? -1 : 1;
  }
  if (line <= parsed.frontmatterEnd || line >= parsed.lines.length) return null;
  return isolatedBlockAtLine(parsed, line);
}

function dispatchMovedLines(
  view: StateCommandTarget,
  parsed: ParsedMarkdown,
  current: LineBlock,
  nextLines: string[],
  newCurrentLine: number,
  userEvent: string,
): boolean {
  const selection = view.state.selection.main;
  const oldFrom = parsed.lines[current.startLine]?.from ?? 0;
  const oldTo = parsed.lines[current.endLine]?.from ?? parsed.text.length;
  const newFrom = lineOffset(nextLines, newCurrentLine);
  const mapSelection = (position: number): number => {
    if (position < oldFrom || position > oldTo) return newFrom;
    return newFrom + (position - oldFrom);
  };
  return dispatchText(
    view,
    nextLines.join("\n"),
    { anchor: mapSelection(selection.anchor), head: mapSelection(selection.head) },
    userEvent,
  );
}

function dispatchMove(
  view: StateCommandTarget,
  parsed: ParsedMarkdown,
  current: LineBlock,
  sibling: LineBlock,
  direction: Direction,
  userEvent: string,
): boolean {
  const first = direction === "up" ? sibling : current;
  const second = direction === "up" ? current : sibling;
  if (first.endLine > second.startLine) return true;
  const source = parsed.lines.map((entry) => entry.text);
  const before = source.slice(0, first.startLine);
  const firstLines = source.slice(first.startLine, first.endLine);
  const gap = source.slice(first.endLine, second.startLine);
  const secondLines = source.slice(second.startLine, second.endLine);
  const after = source.slice(second.endLine);
  let nextLines: string[];
  let newCurrentLine: number;
  if (direction === "down" && current.kind === "paragraph" && sibling.kind === "heading") {
    nextLines = [...before, ...secondLines, ...firstLines, ...gap, ...after];
    newCurrentLine = current.startLine + secondLines.length;
  } else if (direction === "up" && current.kind === "paragraph" && sibling.kind === "heading") {
    let afterCurrent = second.endLine;
    while (afterCurrent < source.length && isBlank(parsed, afterCurrent)) afterCurrent += 1;
    const trailingGap = source.slice(second.endLine, afterCurrent);
    nextLines = [
      ...before,
      ...secondLines,
      ...gap,
      ...trailingGap,
      ...firstLines,
      ...source.slice(afterCurrent),
    ];
    newCurrentLine = sibling.startLine;
  } else {
    nextLines = [...before, ...secondLines, ...gap, ...firstLines, ...after];
    newCurrentLine = direction === "up"
      ? sibling.startLine
      : current.startLine + secondLines.length + gap.length;
  }

  return dispatchMovedLines(view, parsed, current, nextLines, newCurrentLine, userEvent);
}

function moveBlock(view: StateCommandTarget, direction: Direction): boolean {
  const parsed = parseMarkdown(view.state.doc.toString());
  const line = lineAtPosition(parsed, view.state.selection.main.head);
  if (line <= parsed.frontmatterEnd) return true;
  const current = isolatedBlockAtLine(parsed, line);
  const sibling = adjacentBlock(parsed, current, direction);
  return sibling ? dispatchMove(view, parsed, current, sibling, direction, "move.block") : true;
}

export const moveBlockUp: StateCommand = (view) => moveBlock(view, "up");
export const moveBlockDown: StateCommand = (view) => moveBlock(view, "down");

function subtreeAtLine(parsed: ParsedMarkdown, line: number): LineBlock | null {
  const node = trimTrailingBlanks(parsed, nodeBlockAtLine(parsed, line));
  if (node.kind === "list") return node;
  const section = sectionBlockAtLine(parsed, line);
  return section ? trimTrailingBlanks(parsed, section) : null;
}

interface SubtreeTarget {
  block: LineBlock;
  crossesBoundary: boolean;
  insertionLine?: number;
}

function headingLineBlock(
  heading: NonNullable<ReturnType<typeof headingAtLine>>,
): LineBlock {
  return {
    startLine: heading.line,
    endLine: heading.endLine,
    kind: "heading",
    level: heading.level,
  };
}

function listLineBlock(parsed: ParsedMarkdown, line: number): LineBlock | null {
  const marker = listMarker(parsed.lines[line]?.text ?? "");
  return marker
    ? { startLine: line, endLine: line + 1, kind: "list", level: marker.indent }
    : null;
}

function headingDestinationInsertionLine(
  parsed: ParsedMarkdown,
  boundary: LineBlock,
): number {
  const destination = trimTrailingBlanks(parsed, nodeBlockAtLine(parsed, boundary.startLine));
  for (const heading of parsed.headings.values()) {
    if (heading.line >= boundary.endLine && heading.line < destination.endLine) {
      return heading.line;
    }
  }
  return destination.endLine;
}

function listDestinationInsertionLine(
  parsed: ParsedMarkdown,
  boundary: LineBlock,
): number {
  const destination = trimTrailingBlanks(parsed, nodeBlockAtLine(parsed, boundary.startLine));
  for (let line = boundary.endLine; line < destination.endLine; line += 1) {
    if (listMarker(parsed.lines[line]?.text ?? "")) return line;
  }
  return destination.endLine;
}

function previousHeadingSubtree(parsed: ParsedMarkdown, current: LineBlock): SubtreeTarget | null {
  const candidates = [...parsed.headings.values()].filter(
    (heading) => heading.line < current.startLine && heading.level <= current.level,
  );
  const nearest = candidates.at(-1);
  if (!nearest) return null;
  if (nearest.level === current.level) {
    return {
      block: trimTrailingBlanks(parsed, nodeBlockAtLine(parsed, nearest.line)),
      crossesBoundary: false,
    };
  }
  const previousParent = candidates.findLast(
    (heading) => heading.line < nearest.line && heading.level <= nearest.level,
  );
  return previousParent
    ? { block: headingLineBlock(nearest), crossesBoundary: true }
    : null;
}

function previousListSubtree(parsed: ParsedMarkdown, current: LineBlock): SubtreeTarget | null {
  for (let line = current.startLine - 1; line > parsed.frontmatterEnd; line -= 1) {
    if (isBlank(parsed, line) || parsed.fenced[line] || headingAtLine(parsed, line)) return null;
    const marker = listMarker(parsed.lines[line]?.text ?? "");
    if (!marker) continue;
    if (marker.indent < current.level) {
      for (let parentLine = line - 1; parentLine > parsed.frontmatterEnd; parentLine -= 1) {
        if (
          isBlank(parsed, parentLine) ||
          parsed.fenced[parentLine] ||
          headingAtLine(parsed, parentLine)
        ) {
          return null;
        }
        const parentMarker = listMarker(parsed.lines[parentLine]?.text ?? "");
        if (parentMarker && parentMarker.indent <= marker.indent) {
          const boundary = listLineBlock(parsed, line);
          return boundary ? { block: boundary, crossesBoundary: true } : null;
        }
      }
      return null;
    }
    if (marker.indent > current.level) continue;
    const candidate = trimTrailingBlanks(parsed, nodeBlockAtLine(parsed, line));
    if (candidate.endLine <= current.startLine) {
      return { block: candidate, crossesBoundary: false };
    }
  }
  return null;
}

function adjacentSubtree(
  parsed: ParsedMarkdown,
  current: LineBlock,
  direction: Direction,
): SubtreeTarget | null {
  if (direction === "up") {
    return current.kind === "heading"
      ? previousHeadingSubtree(parsed, current)
      : previousListSubtree(parsed, current);
  }
  if (current.kind === "list") {
    if (current.endLine >= parsed.lines.length) return null;
    const candidate = trimTrailingBlanks(parsed, nodeBlockAtLine(parsed, current.endLine));
    if (candidate.kind !== current.kind) return null;
    if (candidate.level === current.level) {
      return { block: candidate, crossesBoundary: false };
    }
    if (candidate.level > current.level) return null;
    const boundary = listLineBlock(parsed, candidate.startLine);
    return boundary
      ? {
          block: boundary,
          crossesBoundary: true,
          insertionLine: listDestinationInsertionLine(parsed, boundary),
        }
      : null;
  }
  let line = current.endLine;
  while (line < parsed.lines.length && isBlank(parsed, line)) line += 1;
  const heading = headingAtLine(parsed, line);
  if (!heading || heading.level > current.level) return null;
  return heading.level === current.level
    ? {
        block: trimTrailingBlanks(parsed, nodeBlockAtLine(parsed, heading.line)),
        crossesBoundary: false,
      }
    : (() => {
        const boundary = headingLineBlock(heading);
        return {
          block: boundary,
          crossesBoundary: true,
          insertionLine: headingDestinationInsertionLine(parsed, boundary),
        };
      })();
}

function dispatchBoundaryMove(
  view: StateCommandTarget,
  parsed: ParsedMarkdown,
  current: LineBlock,
  boundary: LineBlock,
  direction: Direction,
  insertionLine = boundary.endLine,
): boolean {
  const source = parsed.lines.map((entry) => entry.text);
  const currentLines = source.slice(current.startLine, current.endLine);
  let contentEndLine = source.length;
  while (contentEndLine > 0 && isBlank(parsed, contentEndLine - 1)) contentEndLine -= 1;
  const terminalLines = source.slice(contentEndLine);
  let nextLines: string[];
  let newCurrentLine: number;
  if (direction === "down") {
    const gap = source.slice(current.endLine, boundary.startLine);
    const carriedGap = insertionLine < contentEndLine ? gap : [];
    nextLines = [
      ...source.slice(0, current.startLine),
      ...source.slice(boundary.startLine, insertionLine),
      ...currentLines,
      ...carriedGap,
      ...source.slice(insertionLine, contentEndLine),
      ...terminalLines,
    ];
    newCurrentLine = current.startLine + (insertionLine - boundary.startLine);
  } else {
    let afterCurrent = current.endLine;
    while (afterCurrent < contentEndLine && isBlank(parsed, afterCurrent)) afterCurrent += 1;
    const trailingGap = source.slice(current.endLine, afterCurrent);
    const boundaryHasLeadingBlank = boundary.startLine > 0 && isBlank(parsed, boundary.startLine - 1);
    const movedGap =
      current.kind === "heading" &&
        boundary.kind === "heading" &&
        current.endLine === contentEndLine &&
        trailingGap.length === 0 &&
        !boundaryHasLeadingBlank
        ? [""]
        : trailingGap;
    nextLines = [
      ...source.slice(0, boundary.startLine),
      ...currentLines,
      ...movedGap,
      ...source.slice(boundary.startLine, current.startLine),
      ...source.slice(afterCurrent, contentEndLine),
      ...terminalLines,
    ];
    newCurrentLine = boundary.startLine;
  }
  return dispatchMovedLines(
    view,
    parsed,
    current,
    nextLines,
    newCurrentLine,
    "move.subtree",
  );
}

function moveSubtree(view: StateCommandTarget, direction: Direction): boolean {
  const parsed = parseMarkdown(view.state.doc.toString());
  const line = lineAtPosition(parsed, view.state.selection.main.head);
  if (line <= parsed.frontmatterEnd) return true;
  const current = subtreeAtLine(parsed, line);
  if (!current) return true;
  const target = adjacentSubtree(parsed, current, direction);
  if (!target) return true;
  return target.crossesBoundary
    ? dispatchBoundaryMove(
        view,
        parsed,
        current,
        target.block,
        direction,
        target.insertionLine,
      )
    : dispatchMove(view, parsed, current, target.block, direction, "move.subtree");
}

export const moveSubtreeUp: StateCommand = (view) => moveSubtree(view, "up");
export const moveSubtreeDown: StateCommand = (view) => moveSubtree(view, "down");

function replaceAtxLevel(text: string, level: number): string {
  return text.replace(/^( {0,3})#{1,6}((?:[ \t]+.*)?$)/, `$1${"#".repeat(level)}$2`);
}

function setextMarker(text: string, level: number): string {
  const match = text.match(/^( {0,3})(=+|-+)([ \t]*)$/);
  if (!match?.[2]) return text;
  return `${match[1]}${(level === 1 ? "=" : "-").repeat(match[2].length)}${match[3]}`;
}

function removeIndent(text: string): string | null {
  if (text.startsWith("  ")) return text.slice(2);
  if (text.startsWith("\t")) return text.slice(1);
  return null;
}

function selectedListItemLines(
  parsed: ParsedMarkdown,
  selection: StateCommandTarget["state"]["selection"],
): number[] {
  const selected = new Set<number>();
  for (const range of selection.ranges) {
    const startLine = lineAtPosition(parsed, range.from);
    const endPosition = range.empty ? range.to : Math.max(range.from, range.to - 1);
    const endLine = lineAtPosition(parsed, endPosition);
    for (let line = startLine; line <= endLine; line += 1) {
      if (
        line > parsed.frontmatterEnd &&
        !parsed.fenced[line] &&
        listMarker(parsed.lines[line]?.text ?? "")
      ) {
        selected.add(line);
      }
    }
  }
  return [...selected].sort((left, right) => left - right);
}

function selectedListRoots(parsed: ParsedMarkdown, selectedLines: number[]): LineBlock[] {
  const roots: LineBlock[] = [];
  for (const line of selectedLines) {
    if (roots.some((root) => line >= root.startLine && line < root.endLine)) continue;
    roots.push(nodeBlockAtLine(parsed, line));
  }
  return roots;
}

interface OrderedListMarker {
  indent: number;
  number: bigint;
  numberFrom: number;
  numberTo: number;
}

function orderedListMarker(text: string): OrderedListMarker | null {
  const match = text.match(/^([ \t]*)(\d+)[.)][ \t]+/);
  const marker = listMarker(text);
  if (!match?.[2] || !marker) return null;
  const indentation = match[1] ?? "";
  return {
    indent: marker.indent,
    number: BigInt(match[2]),
    numberFrom: indentation.length,
    numberTo: indentation.length + match[2].length,
  };
}

function listRunAt(parsed: ParsedMarkdown, line: number): number[] {
  const target = listMarker(parsed.lines[line]?.text ?? "");
  if (!target) return [];

  const interruptsRun = (candidate: number): boolean => {
    if (candidate <= parsed.frontmatterEnd) return true;
    if (isBlank(parsed, candidate) || headingAtLine(parsed, candidate)) return true;
    const marker = listMarker(parsed.lines[candidate]?.text ?? "");
    return marker !== null && marker.indent < target.indent;
  };

  let startLine = line;
  while (startLine - 1 > parsed.frontmatterEnd && !interruptsRun(startLine - 1)) {
    startLine -= 1;
  }
  let endLine = line + 1;
  while (endLine < parsed.lines.length && !interruptsRun(endLine)) endLine += 1;

  const members: number[] = [];
  for (let candidate = startLine; candidate < endLine; candidate += 1) {
    if (listMarker(parsed.lines[candidate]?.text ?? "")?.indent === target.indent) {
      members.push(candidate);
    }
  }
  return members;
}

function renumberListRun(lines: string[], run: number[], startAtOne: boolean): void {
  const ordered = run.flatMap((line) => {
    const marker = orderedListMarker(lines[line] ?? "");
    return marker ? [{ line, marker }] : [];
  });
  const first = ordered[0];
  if (!first) return;

  const start = startAtOne ? 1n : first.marker.number;
  for (const [offset, { line, marker }] of ordered.entries()) {
    const text = lines[line] ?? "";
    lines[line] = `${text.slice(0, marker.numberFrom)}${start + BigInt(offset)}${text.slice(marker.numberTo)}`;
  }
}

function changeSelectedListLevel(view: StateCommandTarget, delta: LevelDelta): boolean {
  const parsed = parseMarkdown(view.state.doc.toString());
  const selectedLines = selectedListItemLines(parsed, view.state.selection);
  if (selectedLines.length === 0) return false;

  const roots = selectedListRoots(parsed, selectedLines);
  const movableRoots = roots.filter((root) => {
    if (delta < 0) return removeIndent(parsed.lines[root.startLine]?.text ?? "") !== null;
    return true;
  });
  if (movableRoots.length === 0) return false;

  const affectedLines = new Set<number>();
  for (const root of movableRoots) {
    for (let line = root.startLine; line < root.endLine; line += 1) affectedLines.add(line);
  }

  const nextLines = parsed.lines.map((line) => line.text);
  for (const line of [...affectedLines].sort((left, right) => left - right)) {
    const source = nextLines[line];
    if (source === undefined) continue;
    if (delta > 0) {
      nextLines[line] = `  ${source}`;
      continue;
    }
    nextLines[line] = removeIndent(source) ?? source;
  }

  const movedOrderedRoots = movableRoots.flatMap((root) => {
    const marker = orderedListMarker(parsed.lines[root.startLine]?.text ?? "");
    return marker ? [{ root, originalRun: listRunAt(parsed, root.startLine) }] : [];
  });
  const changedParsed = parseMarkdown(nextLines.join("\n"));
  const renumberedRuns = new Set<string>();
  const renumberOnce = (run: number[], startAtOne: boolean): void => {
    const key = run.join(",");
    if (run.length === 0 || renumberedRuns.has(key)) return;
    renumberListRun(nextLines, run, startAtOne);
    renumberedRuns.add(key);
  };

  for (const { root, originalRun } of movedOrderedRoots) {
    const previousSibling = originalRun.filter(
      (line) => line < root.startLine && !affectedLines.has(line),
    ).at(-1);
    const followingSibling = originalRun.find(
      (line) => line >= root.endLine && !affectedLines.has(line),
    );
    const departedSeed = previousSibling ?? followingSibling;
    if (departedSeed !== undefined) {
      renumberOnce(listRunAt(changedParsed, departedSeed), false);
    }

    const joinedRun = listRunAt(changedParsed, root.startLine);
    const hasPrecedingSibling = joinedRun.some((line) => line < root.startLine);
    renumberOnce(joinedRun, !hasPrecedingSibling);
  }

  const changes: ChangeSpec[] = [];
  for (let line = 0; line < nextLines.length; line += 1) {
    const source = parsed.lines[line];
    const next = nextLines[line];
    if (!source || next === undefined || source.text === next) continue;
    const change = minimalChange(source.text, next);
    changes.push({
      from: source.from + change.from,
      to: source.from + change.to,
      insert: change.insert,
    });
  }
  if (changes.length === 0) return false;

  view.dispatch(view.state.update({ changes, userEvent: "change.level", scrollIntoView: true }));
  return true;
}

function changeLevel(
  view: StateCommandTarget,
  delta: LevelDelta,
  withSubtree: boolean,
  listOnly = false,
): boolean {
  const text = view.state.doc.toString();
  const parsed = parseMarkdown(text);
  const selection = view.state.selection.main;
  const line = lineAtPosition(parsed, selection.head);
  if (line <= parsed.frontmatterEnd || parsed.fenced[line]) return listOnly ? false : true;
  const heading = headingAtLine(parsed, line);
  const marker = listMarker(parsed.lines[line]?.text ?? "");
  if (listOnly && !marker) return false;
  const nextLines = parsed.lines.map((entry) => entry.text);
  let affected: number[] = [];

  if (heading && !listOnly) {
    const block = withSubtree ? nodeBlockAtLine(parsed, heading.line) : null;
    affected = withSubtree
      ? [...parsed.headings.values()]
          .filter((candidate) => candidate.line >= heading.line && candidate.line < (block?.endLine ?? 0))
          .map((candidate) => candidate.line)
      : [heading.line];
    const headings = affected.map((candidate) => parsed.headings.get(candidate)!);
    if (headings.some((candidate) => candidate.level + delta < 1 || candidate.level + delta > 6)) {
      return true;
    }
    for (const candidate of headings) {
      if (candidate.style === "atx") {
        nextLines[candidate.line] = replaceAtxLevel(
          nextLines[candidate.line] ?? "",
          candidate.level + delta,
        );
      } else {
        nextLines[candidate.line + 1] = setextMarker(
          nextLines[candidate.line + 1] ?? "",
          candidate.level + delta,
        );
      }
    }
  } else if (marker) {
    const block = withSubtree ? nodeBlockAtLine(parsed, line) : { startLine: line, endLine: line + 1 };
    affected = Array.from(
      { length: block.endLine - block.startLine },
      (_, index) => block.startLine + index,
    );
    if (delta < 0 && removeIndent(nextLines[line] ?? "") === null) return true;
    for (const candidate of affected) {
      const original = nextLines[candidate] ?? "";
      if (delta > 0) nextLines[candidate] = `  ${original}`;
      else nextLines[candidate] = removeIndent(original) ?? original;
    }
  } else {
    return false;
  }

  const oldLine = parsed.lines[line];
  const oldColumn = selection.head - (oldLine?.from ?? 0);
  const lengthDelta = (nextLines[line]?.length ?? 0) - (oldLine?.text.length ?? 0);
  const newHead = lineOffset(nextLines, line) + Math.max(0, oldColumn + lengthDelta);
  return dispatchText(view, nextLines.join("\n"), { anchor: newHead }, "change.level");
}

export const raiseLineLevel: StateCommand = (view) => changeLevel(view, -1, false);
export const lowerLineLevel: StateCommand = (view) => changeLevel(view, 1, false);
export const raiseSubtreeLevel: StateCommand = (view) => changeLevel(view, -1, true);
export const lowerSubtreeLevel: StateCommand = (view) => changeLevel(view, 1, true);

function stripBlockPrefix(text: string): string {
  let remaining = text.replace(/^[ \t]*/, "");
  let previous = "";
  while (remaining !== previous) {
    previous = remaining;
    remaining = remaining.replace(/^(?:#{1,6}[ \t]+|(?:[-+*]|\d+[.)])[ \t]+|>[ \t]?)/, "");
  }
  return remaining;
}

function makeHeading(
  view: StateCommandTarget,
  deeper: boolean,
  explicitLevel?: HeadingLevel,
): boolean {
  const text = view.state.doc.toString();
  const parsed = parseMarkdown(text);
  const line = lineAtPosition(parsed, view.state.selection.main.head);
  if (line <= parsed.frontmatterEnd || parsed.fenced[line]) return true;
  let surrounding = 0;
  for (const heading of parsed.headings.values()) {
    if (heading.line >= line) break;
    surrounding = heading.level;
  }
  const level =
    explicitLevel ?? Math.min(6, Math.max(1, (surrounding || 1) + (deeper ? 1 : 0)));
  const existing = headingAtLine(parsed, line);
  const rootLine = existing?.line ?? line;
  const nextLines = parsed.lines.map((entry) => entry.text);
  nextLines[rootLine] = `${"#".repeat(level)} ${stripBlockPrefix(nextLines[rootLine] ?? "")}`;
  if (existing?.style === "setext") nextLines.splice(rootLine + 1, 1);
  const newHead = lineOffset(nextLines, rootLine) + level + 1;
  return dispatchText(view, nextLines.join("\n"), { anchor: newHead }, "make.heading");
}

export const makeHeadingAtSurroundingLevel: StateCommand = (view) => makeHeading(view, false);
export const makeHeadingOneLevelDeeper: StateCommand = (view) => makeHeading(view, true);
export function makeHeadingAtLevel(level: HeadingLevel): StateCommand {
  return (view) => makeHeading(view, false, level);
}

function jumpHeading(view: StateCommandTarget, direction: Direction): boolean {
  const parsed = parseMarkdown(view.state.doc.toString());
  const line = lineAtPosition(parsed, view.state.selection.main.head);
  const headings = [...parsed.headings.values()];
  const found =
    direction === "down"
      ? headings.find((heading) => heading.line > line)
      : headings.toReversed().find((heading) => heading.line < line);
  if (!found) return true;
  const position = parsed.lines[found.line]?.from ?? 0;
  return dispatchText(view, parsed.text, { anchor: position }, "jump.heading");
}

export const jumpToPreviousHeading: StateCommand = (view) => jumpHeading(view, "up");
export const jumpToNextHeading: StateCommand = (view) => jumpHeading(view, "down");

export const selectCurrentSection: StateCommand = (view) => {
  const parsed = parseMarkdown(view.state.doc.toString());
  const line = lineAtPosition(parsed, view.state.selection.main.head);
  const block = sectionBlockAtLine(parsed, line);
  if (!block) return true;
  const range = blockToRange(parsed, block);
  return dispatchText(view, parsed.text, { anchor: range.from, head: range.to }, "select.section");
};

export const deleteCurrentSection: StateCommand = (view) => {
  const text = view.state.doc.toString();
  const parsed = parseMarkdown(text);
  const line = lineAtPosition(parsed, view.state.selection.main.head);
  const block = sectionBlockAtLine(parsed, line);
  if (!block) return true;
  const range = blockToRange(parsed, block);
  const next = text.slice(0, range.from) + text.slice(range.to);
  return dispatchText(view, next, { anchor: Math.min(range.from, next.length) }, "delete.section");
};

export const indentListItem: StateCommand = (view) => changeSelectedListLevel(view, 1);
export const outdentListItem: StateCommand = (view) => changeSelectedListLevel(view, -1);
