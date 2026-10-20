/** Panes made of setting rows: a section, search results, and the Settings file card. */
import { changedFromDefault, searchSettings, type SettingDef } from "@app-patterns/settings";
import type { MouseEvent, ReactNode } from "react";
import { c, plural } from "./format.ts";
import { SettingRow } from "./row.tsx";
import { Btn, Icon, useEnv } from "./ui.tsx";

export function PaneHead({ icon, title, meta, children }: { icon: string; title: string; meta?: string; children?: ReactNode }): ReactNode {
  return (
    <div className={c("phead")}>
      <Icon name={icon} /><h1>{title}</h1>
      {meta ? <span className={c("meta")}>{meta}</span> : null}
      {children}
    </div>
  );
}

/** The settings of a section as cards, one per group, in the order the schema declares them. */
export function SettingCards({ settings, fallbackGroup }: { settings: readonly SettingDef[]; fallbackGroup: string }): ReactNode {
  const groups = new Map<string, SettingDef[]>();
  for (const d of settings) groups.set(d.group ?? fallbackGroup, [...(groups.get(d.group ?? fallbackGroup) ?? []), d]);
  return (
    <>
      {[...groups].map(([name, rows]) => (
        <div key={name} className={c("card")}>
          <div className={c("ch")}>{name}</div>
          {rows.map((d) => <SettingRow key={d.key} def={d} />)}
        </div>
      ))}
    </>
  );
}

export function TransferCard(): ReactNode {
  const env = useEnv();
  const exportIt = (): void => { void env.run(() => env.actions.exportSettings()); };
  const importIt = (): void => {
    void (async () => {
      try {
        const picked = await env.actions.importPick();
        if (!picked) return;
        env.patch({ sheet: { kind: picked.preview.refused ? "refused" : "import", fileName: picked.fileName, preview: picked.preview } });
      } catch (err) {
        env.patch({ notice: err instanceof Error ? err.message : "The file could not be read" });
      }
    })();
  };
  return (
    <div className={c("card")}>
      <div className={c("ch")}>Settings file</div>
      <div className={c("row")}>
        <div className={c("lab")}><div className={c("t")}>Move settings to another Mac</div></div>
        <div className={c("ctl")}>
          <Btn onClick={exportIt}><Icon name="upload" />Export settings…</Btn>
          <Btn onClick={importIt}><Icon name="download" />Import settings…</Btn>
        </div>
      </div>
    </div>
  );
}

/** A click on the pane's own empty space (not a card or a row) clears the selected setting. Shared by section and search panes. */
function clearSelectionOnEmptySpace(env: ReturnType<typeof useEnv>): (e: MouseEvent<HTMLDivElement>) => void {
  return (e) => { if (e.target === e.currentTarget && env.ui.selKey !== null) env.patch({ selKey: null }); };
}

/** Section panes: General, Appearance, the app's own sections, and any shared section that is only settings. */
export function SectionPane({ section }: { section: string }): ReactNode {
  const env = useEnv();
  const { ctx } = env;
  const sec = ctx.schema.section(section);
  const n = changedFromDefault(ctx.state, ctx.schema, section).count;
  const rows = ctx.schema.settings.filter((d) => d.section === section);
  return (
    <>
      <PaneHead icon={sec?.icon ?? "settings"} title={sec?.label ?? section} {...(n ? { meta: `${n} changed from default` } : {})}>
        {n ? <Btn onClick={() => env.patch({ sheet: { kind: "reset-section", section } })}><Icon name="rotate-ccw" />Reset section…</Btn> : null}
      </PaneHead>
      <div className={c("pscroll")} id="bsw-scroll" onClick={clearSelectionOnEmptySpace(env)}>
        <SettingCards settings={rows} fallbackGroup={sec?.label ?? "Settings"} />
        {section === "general" ? <TransferCard /> : null}
      </div>
    </>
  );
}

/** Search hits per section, from the core's `searchSettings`; a setting's short line counts as help for the search. */
export function useHits(query: string): ReturnType<typeof searchSettings> {
  const { ctx, hints } = useEnv();
  if (!query.trim()) return [];
  const withSummary = ctx.schema.settings.map((d) => (hints[d.key]?.summary ? { ...d, help: `${d.help ?? ""} ${hints[d.key]!.summary}` } : d));
  return searchSettings(withSummary, ctx.schema.sections, query);
}

export function SearchPane({ query }: { query: string }): ReactNode {
  const env = useEnv();
  const hits = useHits(query);
  const bySection = new Map<string, string[]>();
  for (const h of hits) bySection.set(h.section, [...(bySection.get(h.section) ?? []), h.key]);
  const title = `Results for “${query}”`;
  if (hits.length === 0) {
    return (
      <>
        <PaneHead icon="search" title={title} meta="No matches" />
        <div className={c("pscroll")}>
          <div className={c("empty")}>
            <Icon name="search-x" />
            <h2>No settings match “{query}”</h2>
            <p>Nothing in the setting names, help lines or section names.</p>
            <div className={c("acts")}>
              <Btn large onClick={() => env.go("shortcuts", { shortcutText: query })}><Icon name="keyboard" />Search commands in Shortcuts</Btn>
              <Btn large onClick={() => env.patch({ query: "" })}><Icon name="x" />Clear search</Btn>
            </div>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <PaneHead icon="search" title={title} meta={`${plural(hits.length, "setting")} in ${plural(bySection.size, "section")}`} />
      <div className={c("pscroll")} onClick={clearSelectionOnEmptySpace(env)}>
        {[...bySection].map(([sectionId, keys]) => {
          const sec = env.ctx.schema.section(sectionId);
          return (
            <div key={sectionId} className={c("card")}>
              <div className={c("ch")}>
                <Icon name={sec?.icon ?? "settings"} />{sec?.label ?? sectionId}<span className={c("sp")} />
                <a href={`#${sectionId}`} className={c("lk")} onClick={(e) => { e.preventDefault(); env.go(sectionId); }}>Go to section<Icon name="arrow-right" /></a>
              </div>
              {keys.map((k) => { const d = env.ctx.schema.def(k); return d ? <SettingRow key={k} def={d} query={query} /> : null; })}
            </div>
          );
        })}
      </div>
    </>
  );
}
