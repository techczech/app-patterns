/** The Shortcuts page: every command of the registry, rebound in place with a recorder; a clash asks Swap, Replace or Cancel. */
import { changedFromDefault, commandsAdapter, rebindMany } from "@app-patterns/settings";
import type { ReactNode } from "react";
import { Kbd, Recorder } from "./controls.tsx";
import { c, cx } from "./format.ts";
import { commandGroups, commandLabel, showChord, type CommandRow } from "./model.ts";
import { PaneHead, SettingCards } from "./pages-settings.tsx";
import { Btn, Icon, ResetBtn, useEnv, useRowSelect, type Env } from "./ui.tsx";

type Clash = { kind: "taken"; by: string } | { kind: "other"; message: string };

/** What the registry says about giving this command that chord. null = it can be bound. */
function judge(env: Env, id: string, chord: string): Clash | "same" | null {
  const { ctx } = env;
  const check = env.registry.checkRebind(ctx.bindings, id, chord);
  if (check.kind === "ok") return null;
  if (check.kind === "same") return "same";
  if (check.kind === "taken") return { kind: "taken", by: check.by };
  return { kind: "other", message: env.registry.rebindMessage(check, chord) };
}

function bind(env: Env, id: string, chord: string): void {
  const clash = judge(env, id, chord);
  env.patch({ capturing: null });
  if (clash === "same") return;
  if (clash) { env.patch({ conflict: { commandId: id, chord } }); return; }
  env.patch({ conflict: null });
  void env.run(() => env.actions.rebind(id, chord));
}

function ConflictBox({ row }: { row: CommandRow }): ReactNode {
  const env = useEnv();
  const conflict = env.ui.conflict!;
  const clash = judge(env, row.id, conflict.chord);
  const done = (): void => env.patch({ conflict: null });
  if (!clash || clash === "same") return null;
  if (clash.kind === "other") {
    return (
      <div className={c("conf-box")} role="alert">
        <Icon name="circle-alert" /><span>{clash.message}</span><span className={c("sp")} />
        <Btn onClick={done}>Cancel</Btn>
      </div>
    );
  }
  const other = clash.by;
  const swapPairs = [{ commandId: row.id, chord: conflict.chord }, { commandId: other, chord: row.chord }];
  const replacePairs = [{ commandId: row.id, chord: conflict.chord }, { commandId: other, chord: "" }];
  // The pure operation judges the whole batch just as the store does. Discard its proposed state/log;
  // preview clocks never consume host ids, and the eventual action still validates the latest state.
  const previewContext = { schema: env.ctx.schema, commands: commandsAdapter(env.registry), who: { kind: "you" } as const, now: () => 0, newId: () => "preview" };
  const swap = rebindMany(env.ctx.state, swapPairs, previewContext);
  const replace = rebindMany(env.ctx.state, replacePairs, previewContext);
  return (
    <div className={c("conf-box")} role="alert">
      <Icon name="circle-alert" /><span>
        {showChord(conflict.chord)} is used by {commandLabel(env.ctx, other)}.
        {!swap.ok ? <> Swap unavailable: {swap.error}.</> : null}
        {!replace.ok ? <> Replace unavailable: {replace.error}.</> : null}
      </span><span className={c("sp")} />
      <Btn disabled={!swap.ok} onClick={() => { if (!swap.ok) return; done(); void env.run(() => env.actions.rebindMany(swapPairs)); }}>
        <Icon name="arrow-left-right" />Swap
      </Btn>
      <Btn disabled={!replace.ok} onClick={() => { if (!replace.ok) return; done(); void env.run(() => env.actions.rebindMany(replacePairs)); }}>Replace</Btn>
      <Btn onClick={done}>Cancel</Btn>
    </div>
  );
}

function CommandLine({ row }: { row: CommandRow }): ReactNode {
  const env = useEnv();
  const { ui } = env;
  const capturing = ui.capturing === row.id;
  const clash = ui.conflict?.commandId === row.id;
  const pick = useRowSelect(ui.selItem === row.id, () => env.patch({ selItem: row.id }), () => env.patch({ selItem: ui.selItem === row.id ? null : row.id }));
  if (clash) {
    return (
      <div className={c("cmd ch2")} data-command={row.id} {...pick}>
        <div className={c("lab")}>{row.label}</div>
        <Kbd chord={ui.conflict!.chord} kind="conf" />
        <ConflictBox row={row} />
      </div>
    );
  }
  if (capturing) {
    return (
      <div className={c("cmd cap")} data-command={row.id}>
        <div className={c("lab")}>{row.label}<small>Default {showChord(row.defaultChord)}</small></div>
        <Recorder label={row.label} onChord={(ch) => bind(env, row.id, ch)} onCancel={() => env.patch({ capturing: null })} />
        <Btn onClick={() => env.patch({ capturing: null })}>Cancel</Btn>
      </div>
    );
  }
  return (
    <div className={cx("cmd", ui.selItem === row.id && "sel")} data-command={row.id} {...pick}>
      <div className={cx("lab", row.changed && "flexlab")}>{row.label}{row.changed ? <span className={c("tag chg")}>Changed</span> : null}</div>
      {row.changed ? <ResetBtn onClick={() => { void env.run(() => env.actions.reset({ commandId: row.id })); }} /> : null}
      <Kbd
        chord={row.chord} {...(row.fixed ? { kind: "fix" as const, title: "The same in every app, so it cannot be changed" } : { title: "Click, then press the new shortcut", onClick: () => env.patch({ capturing: row.id, conflict: null, selItem: row.id }) })}
      />
    </div>
  );
}

export function ShortcutsPane(): ReactNode {
  const env = useEnv();
  const { ctx, ui } = env;
  const n = changedFromDefault(ctx.state, ctx.schema, "shortcuts").count;
  const show = env.props.showCommand ?? ((d) => d.hidden !== true);
  const groups = commandGroups(ctx, ui.shortcutText, show);
  const own = ctx.schema.settings.filter((d) => d.section === "shortcuts");
  const sec = ctx.schema.section("shortcuts");
  return (
    <>
      <PaneHead icon={sec?.icon ?? "keyboard"} title={sec?.label ?? "Shortcuts"} {...(n ? { meta: `${n} changed` } : {})}>
        {n ? <Btn onClick={() => env.patch({ sheet: { kind: "reset-section", section: "shortcuts" } })}><Icon name="rotate-ccw" />Reset all…</Btn> : null}
      </PaneHead>
      <div className={c("pscroll")}>
        <div className={c("tool")}>
          <div className={c("search2")}>
            <Icon name="search" />
            <input placeholder="Search commands" aria-label="Search commands" value={ui.shortcutText} onChange={(e) => env.patch({ shortcutText: e.target.value })} />
          </div>
        </div>
        {groups.length === 0 ? (
          <div className={c("card")}><div className={c("empty")}><Icon name="search-x" /><h2>No commands match “{ui.shortcutText}”</h2><p>Nothing in the command names or groups.</p></div></div>
        ) : groups.map((g) => (
          <div key={g.group} className={c("card")}>
            <div className={c("ch")}>{g.group}</div>
            {g.rows.map((r) => <CommandLine key={r.id} row={r} />)}
          </div>
        ))}
        {own.length && !ui.shortcutText ? <SettingCards settings={own} fallbackGroup="Other shortcuts" /> : null}
      </div>
    </>
  );
}
