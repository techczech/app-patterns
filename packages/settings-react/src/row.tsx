/** One setting as a row: label, state tags, a line of help or trouble, and the control for its type. */
import { lastChange, type SettingDef, type SettingValue } from "@app-patterns/settings";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Kbd, NumberField, numberDraftError, PathField, Recorder, ChoiceSelect, Segmented, TextField, Toggle } from "./controls.tsx";
import { c, cx, wordsOf } from "./format.ts";
import { currentOf, freshAgentChange, isChanged, showValue } from "./model.ts";
import { Btn, Icon, Mark, ResetBtn, useEnv, useRowSelect, type Env } from "./ui.tsx";

/** A secret row: whether a key is saved, never its value. Adding or replacing happens in Accounts and keys. */
function SecretControl({ def }: { def: SettingDef }): ReactNode {
  const env = useEnv();
  const slot = env.slots.find((s) => s.id === def.key);
  const status = slot?.status ?? "missing";
  const open = (): void => env.go("accounts", { selItem: def.key, addingKey: def.key });
  if (status === "connected") {
    return (
      <>
        <span className={c("secv")}><b>••••••••</b><Icon name="lock" />Saved in Keychain</span>
        <Btn label={`Replace ${def.label}`} onClick={open}>Replace…</Btn>
      </>
    );
  }
  return (
    <>
      <span className={cx("secv", status === "problem" && "bad")}>{status === "problem" ? "Key not accepted" : "Not set"}</span>
      <Btn label={`${status === "problem" ? "Replace" : "Add"} ${def.label}`} onClick={open}>{status === "problem" ? "Replace…" : "Add key…"}</Btn>
    </>
  );
}

function Control({ def, draft, disabled }: { def: SettingDef; draft: string | undefined; disabled: boolean }): ReactNode {
  const env = useEnv();
  const [recording, setRecording] = useState(false);
  // The last number this row asked the host to save and has not yet heard back about. A step compares against it, so a
  // step back to the saved value is still written while an earlier save is in flight.
  const requested = useRef<number | null>(null);
  const hint = env.hints[def.key];
  const value = currentOf(env.ctx, def.key);
  // A saved value that arrives from outside is newer than any request this row made, so the request record is dropped.
  useEffect(() => { requested.current = null; }, [value]);
  const write = (v: SettingValue): void => { void env.run(() => env.actions.set(def.key, v)); };
  switch (def.type) {
    case "toggle":
      return <Toggle on={value === true} label={def.label} onChange={write} />;
    case "choice":
      return hint?.control === "segmented"
        ? <Segmented def={def} value={value} label={def.label} disabled={disabled} onChange={write} />
        : <ChoiceSelect def={def} value={value} label={def.label} onChange={write} />;
    case "text":
      return <TextField value={String(value ?? "")} label={def.label} onCommit={write} />;
    case "number": {
      const step = hint?.step ?? 1;
      const saved = Number(value ?? 0);
      // The one place a number is asked of the host, for both stepping and typed commits. It compares against the last value
      // asked for (the saved value when none is in flight), so a value that returns to the saved value is still written while
      // an earlier save is pending.
      const ask = (next: number): void => {
        if (next === (requested.current ?? saved)) {
          if (draft !== undefined) env.patch({ drafts: omit(env.ui.drafts, def.key) });
          return;
        }
        env.patch({ drafts: omit(env.ui.drafts, def.key) });
        requested.current = next;
        // Clears the record once this write settles, unless a later write has replaced it; a failed write clears it too.
        void env.run(() => env.actions.set(def.key, next)).then(() => { if (requested.current === next) requested.current = null; });
      };
      // Steps from what is typed when that is a number, else from the saved value. Always returns the stepped value so the field shows it.
      const nudge = (dir: 1 | -1, typed?: number): number => {
        let next = Number(((typed ?? saved) + dir * step).toFixed(6));
        if (def.min !== undefined) next = Math.max(def.min, next);
        if (def.max !== undefined) next = Math.min(def.max, next);
        ask(next);
        return next;
      };
      return (
        <NumberField
          def={def} value={saved} draft={draft} label={def.label} step={step}
          onCommit={ask} onStep={nudge}
          onDraft={(t) => env.patch({ drafts: t === null ? omit(env.ui.drafts, def.key) : { ...env.ui.drafts, [def.key]: t } })}
        />
      );
    }
    case "path":
      return (
        <PathField
          path={String(value ?? "")} missing={hint?.missing === true} label={def.label} canChoose={env.actions.choosePath !== undefined}
          onChoose={() => { void (async () => { const p = await env.actions.choosePath?.(def.key); if (p) write(p); })(); }}
        />
      );
    case "chord":
      return recording
        ? <Recorder label={def.label} onCancel={() => setRecording(false)} onChord={(ch) => { setRecording(false); write(ch); }} />
        : <Kbd chord={String(value ?? "")} onClick={() => setRecording(true)} title="Click, then press the new shortcut" />;
    case "secret":
      return <SecretControl def={def} />;
  }
}

const omit = (o: Record<string, string>, key: string): Record<string, string> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

/** What is wrong with the typed text that was not accepted, for the line under the label. */
function draftError(env: Env, def: SettingDef, text: string): string {
  const base = def.type === "number" ? numberDraftError(def, text) : { error: "That value cannot be used" };
  const msg = "error" in base ? base.error : "That value cannot be used";
  return `${msg}. Still using ${showValue(def, currentOf(env.ctx, def.key))}.`;
}

export function SettingRow({ def, query = "" }: { def: SettingDef; query?: string }): ReactNode {
  const env = useEnv();
  const { ctx, ui } = env;
  const hint = env.hints[def.key];
  const words = wordsOf(query);
  const changed = isChanged(ctx, def.key);
  const fresh = freshAgentChange(ctx, def.key);
  const last = changed ? lastChange(ctx.state, def.key) : undefined;
  const byAgent = last?.who.kind === "agent" ? last.who.name : undefined;
  const draft = ui.drafts[def.key];
  const disabled = hint?.disabled !== undefined;
  // A click anywhere on the row opens its inspector and a second click keeps it open (empty pane space clears it: SectionPane).
  const open = (): void => env.patch({ selKey: def.key });
  const select = useRowSelect(ui.selKey === def.key, open, open);
  const cls = cx("row", changed && "changed", fresh && "agent", draft !== undefined && "err", disabled && "dis", ui.selKey === def.key && "sel");

  let mark: ReactNode = null;
  if (fresh && fresh.who.kind === "agent") mark = <span className={c("tag ag")}><Icon name="bot" />Changed by {fresh.who.name} just now</span>;
  else if (byAgent) mark = <span className={c("tag ag")}><Icon name="bot" />Changed by {byAgent}</span>;
  else if (changed) mark = <span className={c("tag chg")}>Changed</span>;

  let sub: ReactNode = null;
  if (fresh) {
    sub = (
      <div className={c("alink")}>
        <Icon name="arrow-right" />
        <a href="#changes" onClick={(e) => { e.preventDefault(); e.stopPropagation(); env.go("changes", { selChange: fresh.id }); }}>Open this entry in Changes</a>
        <span className={c("was")}>· was {showValue(def, fresh.from)}</span>
      </div>
    );
  } else if (hint?.summary) sub = <div className={c("h")}><Mark text={hint.summary} words={words} /></div>;
  else if (changed) sub = <div className={c("h")}>Default: {showValue(def, def.default)}</div>;

  return (
    <div className={cls} data-key={def.key} {...select}>
      <div className={c("lab")}>
        <div className={c("t")}><Mark text={def.label} words={words} />{mark}</div>
        {sub}
        {draft !== undefined ? <div className={c("h e")} role="alert"><Icon name="circle-alert" />{draftError(env, def, draft)}</div> : null}
        {hint?.missing ? <div className={c("h e")}><Icon name="circle-alert" />This folder is not on this Mac.</div> : null}
        {disabled ? <div className={c("h d")}><Icon name="lock" />{hint.disabled}</div> : null}
      </div>
      <div className={c("ctl")} {...(disabled ? ({ inert: "" } as object) : {})}>
        {changed ? <ResetBtn onClick={() => { void env.run(() => env.actions.reset(def.key)); }} /> : null}
        <Control def={def} draft={draft} disabled={disabled} />
      </div>
    </div>
  );
}
