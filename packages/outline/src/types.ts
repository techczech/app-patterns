export type OutlineNodeKind = "heading" | "list" | "paragraph";

export interface OutlineRange {
  from: number;
  to: number;
  kind: OutlineNodeKind;
  level: number;
}
