/** The Changes page: every change newest first, filtered by who, with Reset on each entry and one card per import. */
import { actorOf, batchOf, changeCounts, type ChangeEntry, type ChangeFilter } from "@app-patterns/settings";
import type { ReactNode } from "react";
import { c, clock, cx, whenText } from "./format.ts";
import { changeBlocks, entryView, type ChangeBlock } from "./model.ts";
import { PaneHead } from "./pages-settings.tsx";
import { Btn, Icon, ResetBtn, ResetTag, useEnv, useRowSelect, WhoTag } from "./ui.tsx";

function EntryRow({ e }: { e: ChangeEntry }): ReactNode {
  const env = useEnv();
  const { ctx, ui } = env;
  const v = entryView(ctx, e);
  const fresh = e.at > ctx.seenAt && actorOf(e.who) === "agent";
  const select = useRowSelect(ui.selChange === e.id, () => env.patch({ selChange: e.id }), () => env.patch({ selChange: ui.selChange === e.id ? null : e.id }));
  return (
    <div className={cx("cr", v.isReset && "isr", ui.selChange === e.id && "sel", fresh && "fresh")} data-entry={e.id} {...select}>
      <div className={c("s")}>
        <div><b>{v.title}</b>{v.section ? <small>{v.section}</small> : null}</div>
        <div className={c("c")}>
          {v.summary !== undefined ? <span>{v.summary}</span> : (
            <>
              {v.isReset ? <ResetTag /> : null}
              <span className={c("o")}>{v.from}</span><Icon name="arrow-right" /><span className={c("nw")}>{v.to}</span>
            </>
          )}
        </div>
      </div>
      <div className={c("who")}><WhoTag who={v.who} /><small>{whenText(e.at, ctx.now, true)}</small></div>
      <div>{v.summary === undefined ? <ResetBtn onClick={() => { void env.run(() => env.actions.resetEntry(e.id)); }} /> : null}</div>
    </div>
  );
}

function ImportCard({ block }: { block: Extract<ChangeBlock, { kind: "import" }> }): ReactNode {
  const env = useEnv();
  const info = batchOf(env.ctx.state, block.batch);
  const file = info?.import?.file ?? "file";
  const pick = (): void => env.patch({ selChange: block.batch });
  const select = useRowSelect(env.ui.selChange === block.batch, pick, pick);
  return (
    <div className={cx("card", env.ui.selChange === block.batch && "sel")} data-batch={block.batch}>
      <div className={c("ch imp")} {...select}>
        <Icon name="file-down" /><span className={c("fn")}>Import from {file}</span>
        <span className={c("when")}>· {clock(info?.at ?? 0)}</span><span className={c("sp")} />
        <Btn className={c("flat")} onClick={() => { void env.run(() => env.actions.undoBatch(block.batch)); }}><Icon name="undo-2" />Undo import</Btn>
      </div>
      {block.entries.map((e) => <EntryRow key={e.id} e={e} />)}
    </div>
  );
}

const FILTERS: { id: ChangeFilter; label: string }[] = [
  { id: "all", label: "All" }, { id: "you", label: "You" }, { id: "agent", label: "Agents" }, { id: "app-update", label: "App updates" }, { id: "import", label: "Imports" },
];

export function ChangesPane(): ReactNode {
  const env = useEnv();
  const { ctx, ui } = env;
  const counts = changeCounts(ctx.state);
  const empty = counts.all === 0;
  const blocks = empty ? [] : changeBlocks(ctx, ui.filter, ui.changeText);
  const filters = FILTERS.filter((f) => f.id !== "import" || counts.import > 0 || ui.filter === "import");
  return (
    <>
      <PaneHead icon="clipboard-list" title="Changes" {...(empty ? {} : { meta: "Newest first" })} />
      <div className={c("pscroll")}>
        <div className={c("tool")}>
          <div className={c("search2")}>
            <Icon name="search" />
            <input placeholder="Filter by setting" aria-label="Filter changes" disabled={empty} value={ui.changeText} onChange={(e) => env.patch({ changeText: e.target.value })} />
          </div>
          <div className={c("segf")} role="group" aria-label="Who changed it" style={empty ? { opacity: 0.5 } : undefined}>
            {filters.map((f) => (
              <button key={f.id} type="button" disabled={empty} aria-pressed={ui.filter === f.id} aria-label={empty ? undefined : `${f.label}, ${counts[f.id]} ${counts[f.id] === 1 ? "change" : "changes"}`} className={cx(ui.filter === f.id && "on")} onClick={() => env.patch({ filter: f.id })}>
                {f.label}{empty ? null : <> <em aria-hidden="true">{counts[f.id]}</em></>}
              </button>
            ))}
          </div>
        </div>
        {empty ? (
          <div className={c("card")}><div className={c("empty")}><Icon name="clipboard-list" /><h2>No changes yet</h2><p>Every setting has its default value.</p></div></div>
        ) : blocks.length === 0 ? (
          <div className={c("card")}>
            <div className={c("empty")}>
              <Icon name="search-x" /><h2>No changes match</h2><p>Nothing in the list fits this filter.</p>
              <div className={c("acts")}><Btn large onClick={() => env.patch({ filter: "all", changeText: "" })}><Icon name="x" />Clear filter</Btn></div>
            </div>
          </div>
        ) : blocks.map((b, i) => b.kind === "import" ? <ImportCard key={`i${b.batch}`} block={b} /> : (
          <div key={`d${i}`} className={c("card")}>
            <div className={c("ch")}>{b.label}</div>
            {b.entries.map((e) => <EntryRow key={e.id} e={e} />)}
          </div>
        ))}
      </div>
    </>
  );
}
