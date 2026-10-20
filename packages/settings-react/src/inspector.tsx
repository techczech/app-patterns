/** The fixed right-hand column: recent changes when nothing is selected, otherwise what the selection is, who changed it and how to reset it. */
import { batchOf, changeCounts, historyOf, lastChange, type ChangeEntry, type SettingDef } from "@app-patterns/settings";
import type { ReactNode } from "react";
import { acceleratorOf, commandLabel, currentOf, entryView, isChanged, showChord, showValue, whoView, exampleValue, type Ctx } from "./model.ts";
import { c, cx, isoText, plural, whenText } from "./format.ts";
import { downloadsPath, shellArg } from "./shell.ts";
import { Btn, Icon, ResetBtn, ResetTag, useEnv, WhoTag, type Env } from "./ui.tsx";

function Shell({ title, icon, children }: { title: string; icon: string; children: ReactNode }): ReactNode {
  return (
    <aside className={c("insp")} aria-label="Inspector">
      <h4><Icon name={icon} />{title}</h4>
      {children}
    </aside>
  );
}

function Code({ text }: { text: string }): ReactNode {
  const env = useEnv();
  return (
    <div className={c("code")}>
      <Icon name="terminal" /><span>{text}</span>
      <button type="button" aria-label="Copy command" onClick={() => env.copy(text)}><Icon name="copy" /></button>
    </div>
  );
}

const Kv = ({ rows }: { rows: [string, ReactNode][] }): ReactNode => (
  <div className={c("kv")}>{rows.map(([k, v]) => <div key={k}><span>{k}</span>{typeof v === "string" ? <b title={v}>{v}</b> : v}</div>)}</div>
);

const Sub = ({ children }: { children: ReactNode }): ReactNode => <div className={c("subh")}>{children}</div>;

function HistoryList({ ctx, entries, fmt }: { ctx: Ctx; entries: ChangeEntry[]; fmt?: (e: ChangeEntry) => { from: string; to: string } }): ReactNode {
  if (entries.length === 0) return <div className={c("hist")}><div className={c("never")}>Never changed</div></div>;
  return (
    <div className={c("hist")}>
      {entries.map((e) => {
        const v = entryView(ctx, e);
        const t = fmt ? fmt(e) : { from: v.from, to: v.to };
        return (
          <div key={e.id}>
            <div>{v.isReset ? <><ResetTag />{" "}</> : null}{v.summary ?? <><span className={c("o")} title={t.from}>{t.from}</span> <span className={c("arrow")}>→</span> <b title={t.to}>{t.to}</b></>}</div>
            <div className={c("l2")}><WhoTag who={v.who} /><span>{whenText(e.at, ctx.now)}</span></div>
          </div>
        );
      })}
    </div>
  );
}

function SettingInspector({ def }: { def: SettingDef }): ReactNode {
  const env = useEnv();
  const { ctx } = env;
  const section = ctx.schema.section(def.section)?.label ?? def.section;
  const changed = isChanged(ctx, def.key);
  const last = lastChange(ctx.state, def.key);
  const secret = def.type === "secret";
  const slot = env.slots.find((s) => s.id === def.key);
  const cur = secret ? (slot?.status === "connected" ? "Saved in Keychain" : slot?.status === "problem" ? "Key not accepted" : "Not set") : showValue(def, currentOf(ctx, def.key));
  const draft = env.ui.drafts[def.key];
  const hint = env.hints[def.key];
  const example = exampleValue(def, currentOf(ctx, def.key), hint);
  return (
    <Shell title="Inspector" icon="panel-right">
      <div className={c("ib")}>
        <div><div className={c("nm")}>{def.label}</div><div className={c("where")}><Icon name="layout-list" />{section} › {def.group ?? section}</div></div>
        {def.help ? <p>{def.help}</p> : null}
        <Kv rows={[
          ["Default", secret ? "None" : showValue(def, def.default)],
          ["Current", <b key="c" title={cur}>{cur}{draft !== undefined ? " (kept)" : ""}{changed ? <> <span className={c("tag chg tight")}>Changed</span></> : null}</b>],
          ["Changed by", last ? <WhoTag key="w" who={whoView(last.who)} /> : <span key="w" className={c("tag none")}>Never changed</span>],
        ]} />
        {secret ? null : <div><Sub>History of this setting</Sub><HistoryList ctx={ctx} entries={historyOf(ctx.state, def.key)} /></div>}
        {secret ? null : (
          <Btn kind={changed ? undefined : "dis"} disabled={!changed} className={c("start")} title={`Reset to ${showValue(def, def.default)}`} onClick={() => { void env.run(() => env.actions.reset(def.key)); }}>
            <Icon name="rotate-ccw" />Reset to {showValue(def, def.default)}
          </Btn>
        )}
        <div>
          <Sub>Agent command</Sub>
          {secret
            ? <div className={c("perm")}><Icon name="shield-off" />Agents can see whether a key is saved, never its value.</div>
            : <><Code text={`${ctx.cli} settings set ${shellArg(def.key)} ${shellArg(example)}`} /><Code text={`${ctx.cli} settings reset ${shellArg(def.key)}`} /></>}
        </div>
      </div>
    </Shell>
  );
}

function ShortcutInspector({ id }: { id: string }): ReactNode {
  const env = useEnv();
  const { ctx } = env;
  const def = ctx.registry.byId(id);
  if (!def) return <RecentChanges />;
  const changed = ctx.changed.commands.has(id);
  const chord = ctx.bindings[id] ?? "";
  const last = lastChange(ctx.state, { commandId: id });
  const menu = env.props.menus?.find((m) => m.groups.includes(def.group));
  const full = ctx.registry.defs.find((d) => d.id === id);
  const shown: [string, ReactNode][] = [];
  if (menu && !full?.noMenu) shown.push(["Menu", `${menu.label} › ${def.label}`]);
  shown.push(["Command palette", full?.hidden ? "No" : "Yes"]);
  const help = env.props.commandHelp?.[id];
  const section = ctx.schema.section("shortcuts")?.label ?? "Shortcuts";
  return (
    <Shell title="Inspector" icon="panel-right">
      <div className={c("ib")}>
        <div><div className={c("nm")}>{def.label}</div><div className={c("where")}><Icon name="layout-list" />{section} › {def.group}</div></div>
        {help ? <p>{help}</p> : null}
        <Kv rows={[
          ["Default", showChord(def.key)], ["Current", showChord(chord)],
          ["Changed by", last ? <WhoTag key="w" who={whoView(last.who)} /> : <span key="w" className={c("tag none")}>Never changed</span>],
        ]} />
        <div><Sub>Also shown in</Sub><Kv rows={shown} /></div>
        <HistorySection ctx={ctx} target={{ commandId: id }} />
        <Btn kind={changed ? undefined : "dis"} disabled={!changed} className={c("start")} onClick={() => { void env.run(() => env.actions.reset({ commandId: id })); }}>
          <Icon name="rotate-ccw" />Reset to {showChord(def.key)}
        </Btn>
        {env.props.agentCommandsForShortcuts !== true ? null : (
          <div>
            <Sub>Agent command</Sub>
            <Code text={`${ctx.cli} settings rebind ${shellArg(id)} ${shellArg(acceleratorOf(chord))}`} />
            <Code text={`${ctx.cli} settings reset-shortcut ${shellArg(id)}`} />
          </div>
        )}
      </div>
    </Shell>
  );
}

/** History of a command, shown only when it has any (a never-changed shortcut shows the other blocks only, as the design does). */
function HistorySection({ ctx, target }: { ctx: Ctx; target: { commandId: string } }): ReactNode {
  const entries = historyOf(ctx.state, target);
  if (entries.length === 0) return null;
  return <div><Sub>History of this shortcut</Sub><HistoryList ctx={ctx} entries={entries} /></div>;
}

function AccountInspector({ id }: { id: string }): ReactNode {
  const env = useEnv();
  const slot = env.slots.find((s) => s.id === id);
  if (!slot) return <RecentChanges />;
  const group = slot.group ?? (slot.kind === "account" ? "Accounts" : "Services");
  const status = slot.status === "connected" ? (slot.kind === "account" ? "Signed in" : "Connected") : slot.status === "problem" ? "Needs attention" : "Not connected";
  return (
    <Shell title="Inspector" icon="panel-right">
      <div className={c("ib")}>
        <div><div className={c("nm")}>{slot.label}</div><div className={c("where")}><Icon name="layout-list" />Accounts and keys › {group}</div></div>
        <Kv rows={[["Status", status], ["Stored in", "Keychain"], ["In settings file", "No"]]} />
        {slot.usedBy?.length ? <div><Sub>Used by</Sub><Kv rows={slot.usedBy.map((u): [string, ReactNode] => [u.area, u.what])} /></div> : null}
        {slot.history?.length ? (
          <div>
            <Sub>History</Sub>
            <div className={c("hist")}>
              {slot.history.map((h, i) => (
                <div key={i}><div>{h.text}</div><div className={c("l2")}><WhoTag who={{ kind: h.who, label: h.whoName ?? ({ you: "You", agent: "Agent", "app-update": "App update", import: "Import" })[h.who] }} /><span>{h.at}</span></div></div>
              ))}
            </div>
          </div>
        ) : null}
        <div>
          <Sub>Agent command</Sub>
          <Code text={`${env.ctx.cli} settings get ${shellArg(slot.id)} --json`} />
          <div className={c("perm")}><Icon name="shield-off" />Agents can see whether a key is saved, never its value.</div>
        </div>
      </div>
    </Shell>
  );
}

function BatchInspector({ batch }: { batch: string }): ReactNode {
  const env = useEnv();
  const { ctx } = env;
  const info = batchOf(ctx.state, batch);
  if (!info) return <Empty />;
  const imp = info.import;
  const file = imp?.file ?? "";
  const rows: [string, string][] = [["Imported", whenText(info.at, ctx.now)]];
  if (imp?.exportedFrom) rows.push(["Exported from", imp.exportedFrom]);
  const on = isoText(imp?.exportedAt, ctx.now);
  if (on) rows.push(["Exported on", on]);
  rows.push(["Changed", plural(info.entries.length, "setting")]);
  if (info.skipped.length) rows.push(["Skipped", plural(info.skipped.length, "setting")]);
  return (
    <Shell title="Inspector" icon="panel-right">
      <div className={c("ib")}>
        <div><div className={c("nm")}>Import from file</div><div className={c("where")}><Icon name="file-json" />{file}</div></div>
        <Kv rows={rows} />
        {info.skipped.length ? (
          <div>
            <Sub>Skipped</Sub>
            <div className={c("hist")}>
              {info.skipped.map((s, i) => (
                <div key={i}>
                  <div><b>{s.key !== undefined ? ctx.schema.def(s.key)?.label ?? s.key : commandLabel(ctx, s.commandId ?? "")}</b></div>
                  <div className={c("skipwhy")}>{s.reason}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <Btn className={c("start")} onClick={() => { void env.run(() => env.actions.undoBatch(batch)); }}><Icon name="undo-2" />Undo import</Btn>
        <div>
          <Sub>Agent command</Sub>
          <Code text={`${ctx.cli} settings import ${downloadsPath(file)}`} />
          <Code text={`${ctx.cli} settings undo-import ${shellArg(batch)}`} />
        </div>
      </div>
    </Shell>
  );
}

function Empty(): ReactNode {
  return <Shell title="Inspector" icon="panel-right"><div className={c("iempty")}><Icon name="mouse-pointer-click" /><b>No change selected</b></div></Shell>;
}

export function RecentChanges(): ReactNode {
  const env = useEnv();
  const { ctx } = env;
  const list = ctx.state.changes.slice(0, 5);
  return (
    <Shell title="Recent changes" icon="history">
      <div className={c("rc")}>
        {list.length === 0 ? <div className={c("iempty")}><Icon name="clipboard-list" /><b>No changes yet</b></div> : null}
        {list.map((e) => {
          const v = entryView(ctx, e);
          return (
            <div key={e.id} className={cx("rci")}>
              <div className={c("s")}>{v.title}</div>
              {v.summary === undefined ? <ResetBtn onClick={() => { void env.run(() => env.actions.resetEntry(e.id)); }} /> : null}
              <div className={c("v")} title={v.summary === undefined ? `${v.from} → ${v.to}` : undefined}>{v.summary ?? <>{v.isReset ? <><ResetTag />{" "}</> : null}<span className={c("o")}>{v.from}</span> <span className={c("arrow")}>→</span> {v.to}</>}</div>
              <div className={c("l2")}><WhoTag who={v.who} /><span>{whenText(e.at, ctx.now)}</span></div>
            </div>
          );
        })}
      </div>
      <div className={c("rcfoot")}>
        <Btn onClick={() => env.go("changes")}><Icon name="list" />All changes ({changeCounts(ctx.state).all})</Btn>
      </div>
    </Shell>
  );
}

export function Inspector(): ReactNode {
  const env = useEnv();
  const { ui, ctx } = env;
  const setting = (key: string | null | undefined): SettingDef | undefined => (key ? ctx.schema.def(key) : undefined);
  if (ui.query) {
    const d = setting(ui.selKey);
    return d ? <SettingInspector def={d} /> : <RecentChanges />;
  }
  switch (ui.section) {
    case "shortcuts": return ui.selItem ? <ShortcutInspector id={ui.selItem} /> : <RecentChanges />;
    case "accounts": return ui.selItem ? <AccountInspector id={ui.selItem} /> : <RecentChanges />;
    case "changes": {
      if (!ui.selChange) return <Empty />;
      if (batchOf(ctx.state, ui.selChange)) return <BatchInspector batch={ui.selChange} />;
      const e = ctx.state.changes.find((x) => x.id === ui.selChange);
      if (!e) return <Empty />;
      if (e.commandId !== undefined) return <ShortcutInspector id={e.commandId} />;
      const d = setting(e.key);
      return d ? <SettingInspector def={d} /> : <Empty />;
    }
    case "about": return <RecentChanges />;
    default: {
      const d = setting(ui.selKey);
      return d ? <SettingInspector def={d} /> : <RecentChanges />;
    }
  }
}

export type { Env };
