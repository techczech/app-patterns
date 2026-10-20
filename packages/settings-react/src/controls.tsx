/** The controls of a setting row, one per setting type. Each reports a value or a typed draft; none writes anything itself. */
import { chordFromEvent } from "@app-patterns/commands";
import { checkValue, type SettingDef, type SettingValue } from "@app-patterns/settings";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { c, cx } from "./format.ts";
import { showChord } from "./model.ts";
import { Btn, Icon } from "./ui.tsx";

export function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange(v: boolean): void }): ReactNode {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} className={cx("tg", on && "on")}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
    >
      <i />
    </button>
  );
}

export function ChoiceSelect({ def, value, label, onChange }: { def: SettingDef; value: SettingValue | null; label: string; onChange(v: SettingValue): void }): ReactNode {
  const opts = def.options ?? [];
  const idx = opts.findIndex((o) => o.value === value);
  return (
    <span className={c("sel2")} onClick={(e) => e.stopPropagation()}>
      <span>{opts[idx]?.label ?? String(value ?? "")}</span>
      <Icon name="chevrons-up-down" />
      <select
        aria-label={label} value={String(idx)}
        onChange={(e) => { const o = opts[Number(e.target.value)]; if (o) onChange(o.value); }}
      >
        {opts.map((o, i) => <option key={i} value={String(i)}>{o.label}</option>)}
      </select>
    </span>
  );
}

export function Segmented({ def, value, label, disabled, onChange }: { def: SettingDef; value: SettingValue | null; label: string; disabled?: boolean; onChange(v: SettingValue): void }): ReactNode {
  return (
    <span className={c("seg")} role="radiogroup" aria-label={label} onClick={(e) => e.stopPropagation()}>
      {(def.options ?? []).map((o) => (
        <button
          key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} disabled={disabled}
          className={cx(o.value === value && "on")} onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** Text that is committed on Enter or when the field loses focus. */
export function TextField({ value, label, onCommit }: { value: string; label: string; onCommit(v: string): void }): ReactNode {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (): void => { if (text !== value) onCommit(text); };
  return (
    <input
      className={c("txt")} aria-label={label} value={text} onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setText(value); }}
    />
  );
}

/** Why typed text is not a value for this number setting, in words; null when it is one. */
export function numberDraftError(def: SettingDef, text: string): { value: number } | { error: string } {
  const n = text.trim() === "" ? Number.NaN : Number(text);
  const err = Number.isFinite(n) ? checkValue(def, n) : "Must be a number";
  if (err === null) return { value: n };
  if (def.min !== undefined && def.max !== undefined && (!Number.isFinite(n) || n < def.min || n > def.max)) {
    return { error: `Enter a number from ${def.min} to ${def.max}` };
  }
  return { error: err };
}

export function NumberField({ def, value, draft, label, step, onCommit, onDraft, onStep }: {
  def: SettingDef; value: number; draft: string | undefined; label: string; step: number;
  onCommit(v: number): void; onDraft(text: string | null): void; onStep(dir: 1 | -1, typed?: number): number;
}): ReactNode {
  const [text, setText] = useState(draft ?? String(value));
  useEffect(() => setText(draft ?? String(value)), [draft, value]);
  // The field shows the stepped value even when it equals the saved value, so the next step and blur read it.
  const stepBy = (dir: 1 | -1, typed?: number): void => { setText(String(onStep(dir, typed))); };
  // Every valid commit is passed up; the owner decides whether it differs from the value last asked for.
  const commit = (): void => {
    const r = numberDraftError(def, text);
    if ("value" in r) { onDraft(null); onCommit(r.value); } else onDraft(text);
  };
  return (
    <span className={cx("num", draft !== undefined && "bad")} onClick={(e) => e.stopPropagation()}>
      <input
        inputMode="decimal" aria-label={label} aria-invalid={draft !== undefined} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const typed = text.trim() === "" ? Number.NaN : Number(text);
            stepBy(e.key === "ArrowUp" ? 1 : -1, Number.isFinite(typed) ? typed : undefined);
          }
        }}
      />
      <span className={c("u")}>{def.unit ?? ""}</span>
      <span className={c("st")}>
        <Icon name="chevrons-up-down" />
        <button type="button" tabIndex={-1} aria-label={`Increase ${label}`} className={c("up")} onClick={() => stepBy(1)} data-step={step} />
        <button type="button" tabIndex={-1} aria-label={`Decrease ${label}`} className={c("down")} onClick={() => stepBy(-1)} />
      </span>
    </span>
  );
}

export function PathField({ path, missing, label, canChoose, onChoose }: { path: string; missing: boolean; label: string; canChoose: boolean; onChoose(): void }): ReactNode {
  return (
    <>
      <span className={cx("path", missing && "miss")} title={path}>
        <Icon name={missing ? "folder-x" : "folder"} /><span>{path || "None"}</span>
      </span>
      <Btn label={`Choose ${label}`} disabled={!canChoose} onClick={onChoose}>Choose…</Btn>
    </>
  );
}

/** A key combination as the menu shows it; empty is "None". */
export function Kbd({ chord, kind, title, onClick }: { chord: string; kind?: "conf" | "fix"; title?: string; onClick?: () => void }): ReactNode {
  return (
    <button
      type="button" className={cx("kbd", kind, !chord && "nochord")} title={title} disabled={!onClick}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
    >
      {showChord(chord)}
    </button>
  );
}

/** Takes the next key combination pressed. Esc cancels; Backspace or Delete on its own removes the shortcut. */
export function Recorder({ onChord, onCancel, label }: { onChord(chord: string): void; onCancel(): void; label: string }): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (e.key === "Escape" && bare) return onCancel();
    if ((e.key === "Backspace" || e.key === "Delete") && bare) return onChord("");
    const chord = chordFromEvent({ code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey });
    if (chord) onChord(chord);
  };
  return (
    <button ref={ref} type="button" className={c("kbd rec")} aria-label={`New shortcut for ${label}`} onKeyDown={onKey} onBlur={onCancel} onClick={(e) => e.stopPropagation()}>
      Press new shortcut…
    </button>
  );
}
