/** Small shared pieces: icons, the "who" tag, highlighted text, buttons. */
import * as lucide from "lucide-react";
import { createContext, useContext, useRef, type KeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { c, cx, escapeRegExp, pascal } from "./format.ts";
import type { Ctx, WhoView } from "./model.ts";
import type { SettingsActions, SettingsRegistry, Slot, UiState, RowHint, SettingsWindowProps } from "./types.ts";

type IconCmp = typeof lucide.Circle;

export function Icon({ name, className }: { name: string; className?: string }): ReactNode {
  const key = pascal(name);
  const all = lucide as unknown as Record<string, IconCmp | undefined>;
  const Cmp = (lucide.icons as unknown as Record<string, IconCmp | undefined>)[key] ?? all[key] ?? lucide.Circle;
  return <Cmp aria-hidden="true" {...(className ? { className: c(className) } : {})} />;
}

const WHO_ICON: Record<WhoView["kind"], [string, string]> = {
  agent: ["ag", "bot"],
  you: ["you", "user"],
  "app-update": ["app", "package"],
  import: ["imp", "file-down"],
  other: ["imp", "circle-help"],
};

export function WhoTag({ who }: { who: WhoView }): ReactNode {
  const [cls, icon] = WHO_ICON[who.kind];
  return <span className={cx("tag", cls)}><Icon name={icon} />{who.label}</span>;
}

export function ResetTag(): ReactNode {
  return <span className={c("tag rs")}><Icon name="rotate-ccw" />Reset</span>;
}

/** Text with every searched word marked. */
export function Mark({ text, words }: { text: string; words: readonly string[] }): ReactNode {
  if (words.length === 0) return text;
  const re = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(re);
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p));
}

export interface BtnProps {
  children: ReactNode;
  /** Tooltip with the full text, for a label that wraps. */
  title?: string;
  onClick?: () => void;
  kind?: "pri" | "dng" | "dngp" | "dis";
  large?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
  /** The control a sheet focuses when it opens. */
  initial?: boolean;
}
export function Btn({ children, onClick, kind, large, disabled, label, className, initial, title }: BtnProps): ReactNode {
  return (
    <button
      type="button"
      className={`${cx("btn", kind, large && "lg", disabled && "dis")}${className ? ` ${className}` : ""}`}
      disabled={disabled}
      aria-label={label}
      {...(title ? { title } : {})}
      {...(initial ? { "data-initial": "" } : {})}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
    >
      {children}
    </button>
  );
}

export function ResetBtn({ onClick, label = "Reset" }: { onClick: () => void; label?: string }): ReactNode {
  return (
    <button type="button" className={c("rst")} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <Icon name="rotate-ccw" />{label}
    </button>
  );
}

/**
 * What makes a row selectable from the keyboard as well as the mouse: it takes focus, Enter or Space on the row itself selects it,
 * and focusing the row or any control in it selects it. A click toggles the selection, except the click that follows a focus
 * which has just selected the row (a mouse press focuses, then clicks).
 */
export function useRowSelect(selected: boolean, select: () => void, toggle: () => void) {
  const byFocus = useRef(false);
  return {
    tabIndex: 0,
    "aria-current": selected ? ("true" as const) : undefined,
    onClick: (): void => {
      if (byFocus.current) { byFocus.current = false; if (selected) return; }
      toggle();
    },
    onFocus: (): void => { if (!selected) { byFocus.current = true; select(); } },
    onBlur: (e: { currentTarget: Element; relatedTarget: EventTarget | null }): void => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) byFocus.current = false;
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>): void => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
    },
  };
}

/** Everything the parts of the window share. */
export interface Env {
  ctx: Ctx;
  ui: UiState;
  patch(p: Partial<UiState>): void;
  go(section: string, p?: Partial<UiState>): void;
  /** Runs an action; shows its error as a notice and returns whether it succeeded. */
  run(fn: () => ReturnType<SettingsActions["set"]>): Promise<boolean>;
  actions: SettingsActions;
  registry: SettingsRegistry;
  slots: Slot[];
  hints: Record<string, RowHint>;
  props: SettingsWindowProps;
  copy(text: string): void;
  /** The control that had focus before a sheet opened, so closing the sheet can give focus back. */
  opener: MutableRefObject<HTMLElement | null>;
  /** Applies an import preview; when it succeeds, opens Changes on the new batch. */
  applyImport(preview: import("@app-patterns/settings").ImportPreview, fileName: string): Promise<boolean>;
}

export const EnvContext = createContext<Env | null>(null);
export function useEnv(): Env {
  const e = useContext(EnvContext);
  if (!e) throw new Error("useEnv outside the Settings window");
  return e;
}
