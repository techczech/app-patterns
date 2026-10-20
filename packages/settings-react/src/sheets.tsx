/** The sheets that hang from the title bar: confirm a reset, preview an import, refuse a wrong file. */
import { changedFromDefault, type ImportChange, type ImportPreview } from "@app-patterns/settings";
import { useEffect, useRef, type KeyboardEvent as ReactKeyEvent, type ReactNode } from "react";
import { c, countText, isoLong, plural } from "./format.ts";
import { commandLabel, showChord, showValue } from "./model.ts";
import { Btn, Icon, useEnv, type Env } from "./ui.tsx";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal sheet. On opening, focus goes to its primary safe control (the one marked `initial`, else the first); Tab and Shift+Tab
 * wrap inside it; closing gives focus back to the control that opened it. The background is made inert by the window (`.bsw-body`)
 * and Escape is Cancel (handled in `Sheets`).
 */
function Sheet({ children, className, label }: { children: ReactNode; className?: string; label: string }): ReactNode {
  const env = useEnv();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    (dialog?.querySelector<HTMLElement>("[data-initial]:not([disabled])") ?? dialog?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => {
      const opener = env.opener.current;
      if (opener?.isConnected) opener.focus();
    };
  }, [env.opener]);
  const onKeyDown = (e: ReactKeyEvent<HTMLDivElement>): void => {
    if (e.key !== "Tab") return;
    const dialog = ref.current;
    const items = dialog ? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    e.preventDefault();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at < 0 || at === items.length - 1 ? 0 : at + 1);
    items[next]?.focus();
  };
  return (
    <div className={c("scrim")}>
      <div ref={ref} className={`${c("sheet")}${className ? ` ${c(className)}` : ""}`} role="dialog" aria-modal="true" aria-label={label} onKeyDown={onKeyDown}>{children}</div>
    </div>
  );
}

function ResetSheet({ section }: { section?: string }): ReactNode {
  const env = useEnv();
  const { ctx } = env;
  const n = changedFromDefault(ctx.state, ctx.schema, section);
  const label = section ? ctx.schema.section(section)?.label ?? section : "";
  const title = section === undefined ? "Reset all settings?" : section === "shortcuts" ? "Reset all shortcuts?" : `Reset ${label}?`;
  const close = (): void => env.patch({ sheet: null });
  return (
    <Sheet label={title}>
      <h3><Icon name="triangle-alert" />{title}</h3>
      <p>
        {n.count === 0 ? "Nothing differs from the defaults here." : `${countText(n.settings.length, n.keys.length)} return to their defaults. Each reset is listed in Changes and can be undone there.`}
      </p>
      <div className={c("acts")}>
        <Btn large initial onClick={close}>Cancel</Btn>
        <Btn large kind="dngp" disabled={n.count === 0} onClick={() => { close(); void env.run(() => (section === undefined ? env.actions.resetAll() : env.actions.resetSection(section))); }}>
          Reset {plural(n.count, "setting")}
        </Btn>
      </div>
    </Sheet>
  );
}

function changeLabel(env: Env, ch: ImportChange): { name: string; section: string; from: string; to: string } {
  const { ctx } = env;
  if (ch.key !== undefined) {
    const def = ctx.schema.def(ch.key);
    return { name: def?.label ?? ch.key, section: ctx.schema.section(ch.section)?.label ?? ch.section, from: showValue(def, ch.from), to: showValue(def, ch.to) };
  }
  const id = ch.commandId ?? "";
  return { name: `Shortcut: ${commandLabel(ctx, id)}`, section: ctx.schema.section("shortcuts")?.label ?? "Shortcuts", from: showChord(String(ch.from ?? "")), to: showChord(String(ch.to)) };
}

function ImportSheet({ fileName, preview }: { fileName: string; preview: ImportPreview }): ReactNode {
  const env = useEnv();
  const { ctx } = env;
  const src = preview.source;
  const when = isoLong(src?.exportedAt);
  const from = [src?.exportedFrom ? `Exported from ${src.exportedFrom}` : "Exported", when ? `on ${when}` : null].filter(Boolean).join(" ");
  const tail = src?.appVersion ? ` · ${env.props.appInfo.name} ${src.appVersion}` : "";
  const close = (): void => env.patch({ sheet: null });
  const n = preview.changes.length;
  return (
    <Sheet className="impsheet" label="Import settings">
      <h3><Icon name="file-down" />Import settings from “{fileName}”?</h3>
      <div className={c("from")}>{from}{tail}</div>
      <div className={c("ptbl")}>
        <div className={c("ph")}><span>{plural(n, "setting")} will change</span><span className={c("sp")} /><span>This Mac → file</span></div>
        {preview.changes.map((ch, i) => {
          const l = changeLabel(env, ch);
          return (
            <div key={i} className={c("pr")}>
              <div>{l.name}<small>{l.section}</small></div>
              <div className={c("c")}><span className={c("o")}>{l.from}</span><Icon name="arrow-right" /><span className={c("nw")}>{l.to}</span></div>
            </div>
          );
        })}
        {preview.skipped.map((s, i) => (
          <div key={`s${i}`} className={c("pr skip")}>
            <div>{s.key !== undefined ? ctx.schema.def(s.key)?.label ?? s.key : `Shortcut: ${commandLabel(ctx, s.commandId ?? "")}`}<small>{s.key !== undefined ? ctx.schema.section(ctx.schema.def(s.key)?.section ?? "")?.label ?? "" : ctx.schema.section("shortcuts")?.label ?? "Shortcuts"}</small></div>
            <div className={c("c")}><Icon name="circle-alert" /><span>{s.reason} Skipped.</span></div>
          </div>
        ))}
      </div>
      <div className={c("notes")}>
        {preview.alreadyMatch > 0 ? <div><Icon name="circle-check" />{preview.alreadyMatch === 1 ? "1 other setting in the file already matches" : `${preview.alreadyMatch} other settings in the file already match`} this Mac.</div> : null}
        <div><Icon name="key-round" />Account keys are not in the file. Keys on this Mac stay as they are.</div>
      </div>
      <div className={c("acts")}>
        <span className={c("sp")} />
        <Btn large initial onClick={close}>Cancel</Btn>
        <Btn large kind="pri" disabled={n === 0} onClick={() => { close(); void env.applyImport(preview, fileName); }}>Import {plural(n, "setting")}</Btn>
      </div>
    </Sheet>
  );
}

function RefusedSheet({ fileName, preview }: { fileName: string; preview: ImportPreview }): ReactNode {
  const env = useEnv();
  const app = env.props.appInfo.name;
  const r = preview.refused!;
  const other = r.code === "other-app" && r.app ? env.props.appNames?.[r.app] ?? r.app : undefined;
  const title = other ? `This file holds ${other} settings` : "This file cannot be imported";
  const body = other ? `“${fileName}” cannot be imported into ${app}. Choose a ${app} settings file.` : `“${fileName}”: ${r.message.replace(/\.$/, "")}.`;
  const close = (): void => env.patch({ sheet: null });
  return (
    <Sheet label={title}>
      <h3><Icon name="triangle-alert" />{title}</h3>
      <p>{body}</p>
      <div className={c("acts")}>
        <Btn large onClick={close}>Cancel</Btn>
        <Btn large initial kind="pri" onClick={() => {
          close();
          void (async () => {
            const picked = await env.actions.importPick();
            if (picked) env.patch({ sheet: { kind: picked.preview.refused ? "refused" : "import", fileName: picked.fileName, preview: picked.preview } });
          })();
        }}>Choose another file…</Btn>
      </div>
    </Sheet>
  );
}

/** Esc closes whichever sheet is open. */
export function Sheets(): ReactNode {
  const env = useEnv();
  const sheet = env.ui.sheet;
  useEffect(() => {
    if (!sheet) return undefined;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") env.patch({ sheet: null }); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet, env]);
  if (!sheet) return null;
  switch (sheet.kind) {
    case "reset-all": return <ResetSheet />;
    case "reset-section": return <ResetSheet section={sheet.section} />;
    case "import": return <ImportSheet fileName={sheet.fileName} preview={sheet.preview} />;
    case "refused": return <RefusedSheet fileName={sheet.fileName} preview={sheet.preview} />;
  }
}

/** What an export file holds, for the accessory under the native save panel (the demo draws it; a host with its own sheet can too). */
export function ExportIncludes({ settings, shortcuts }: { settings: number; shortcuts: number }): ReactNode {
  return (
    <div className={c("acc")}>
      <div><Icon name="file-json" /><span>Includes {plural(settings, "setting")} changed from default{shortcuts > 0 ? ` and ${plural(shortcuts, "shortcut")}` : ""}.</span></div>
      <div className={c("k")}><Icon name="key-round" /><span>Account keys are not exported. They stay in Keychain on this Mac.</span></div>
    </div>
  );
}
