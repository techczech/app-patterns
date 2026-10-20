/** The Settings window: sidebar, one pane, the fixed inspector and the sheets. Driven only by props; it keeps nothing but its own view state. */
import { changeCounts, filterChanges, lastImportBatch, newSince, type ImportPreview, type Section } from "@app-patterns/settings";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { c, cx } from "./format.ts";
import { Inspector } from "./inspector.tsx";
import { changedSets, type Ctx } from "./model.ts";
import { ChangesPane } from "./pages-changes.tsx";
import { AboutPane, AccountsPane } from "./pages-accounts-about.tsx";
import { PaneHead, SearchPane, SectionPane, useHits } from "./pages-settings.tsx";
import { ShortcutsPane } from "./pages-shortcuts.tsx";
import { Sheets } from "./sheets.tsx";
import { Icon, EnvContext, useEnv, type Env } from "./ui.tsx";
import type { CustomPage, SettingsWindowProps, UiState } from "./types.ts";

export const initialUi = (): UiState => ({
  section: "general", query: "", selKey: null, selChange: null, selItem: null, filter: "all", changeText: "", shortcutText: "",
  capturing: null, conflict: null, addingKey: null, drafts: {}, sheet: null, notice: null, focusSearch: false,
});

interface NavEntry { id: string; label: string; icon: string }

/** Sections whose pane is not made of the schema's rows: they always have something to show. */
const BUILT_IN_PANES = new Set(["general", "shortcuts", "accounts", "changes", "about"]);

/**
 * Whether `id` has a pane for this app: a built-in pane, a custom page, or at least one setting. A shared section the app put nothing
 * in (Appearance for an app with no appearance settings) has none, so it is left out of the sidebar and a link to it opens General.
 */
export function hasPane(schema: SettingsWindowProps["schema"], pages: readonly CustomPage[], id: string): boolean {
  return BUILT_IN_PANES.has(id) || pages.some((p) => p.id === id) || schema.settings.some((d) => d.section === id);
}

function NavItem({ item, selected, count, muted, badge }: { item: NavEntry; selected: boolean; count?: number; muted?: boolean; badge?: ReactNode }): ReactNode {
  const env = useEnv();
  return (
    <button type="button" className={cx("nav", selected && "sel", muted && "muted")} data-section={item.id} aria-current={selected ? "page" : undefined} onClick={() => env.go(item.id)}>
      <Icon name={item.icon} /><span className={c("n")}>{item.label}</span>
      {badge ?? (count ? <span className={c("cnt")}>{count}</span> : null)}
    </button>
  );
}

function Sidebar({ pages }: { pages: CustomPage[] }): ReactNode {
  const env = useEnv();
  const { ctx, ui } = env;
  const searching = ui.query.trim() !== "";
  const hits = useHits(ui.query);
  const perSection = new Map<string, number>();
  for (const h of hits) perSection.set(h.section, (perSection.get(h.section) ?? 0) + 1);
  const entry = (s: Section): NavEntry => ({ id: s.id, label: s.label, icon: s.icon });
  const custom = (place: "all" | "app"): NavEntry[] => pages.filter((p) => (p.placement ?? "app") === place).map((p) => ({ id: p.id, label: p.label, icon: p.icon }));
  const shown = (s: Section): boolean => hasPane(ctx.schema, pages, s.id) && !pages.some((p) => p.id === s.id);
  const top = [...ctx.schema.sections.filter((s) => s.shared && !s.pinned && shown(s)).map(entry), ...custom("all")];
  const own = [...ctx.schema.sections.filter((s) => !s.shared && shown(s)).map(entry), ...custom("app")];
  const pinned = ctx.schema.sections.filter((s) => s.pinned).map(entry);
  const item = (e: NavEntry): ReactNode => (
    <NavItem key={e.id} item={e} selected={!searching && ui.section === e.id} {...(searching ? { count: perSection.get(e.id) ?? 0, muted: !perSection.get(e.id) } : {})} />
  );
  const total = changeCounts(ctx.state).all;
  const fresh = newSince(ctx.state, ctx.seenAt);
  const freshImports = filterChanges(ctx.state, { who: "import" }).filter((e) => e.at > ctx.seenAt).length === fresh;
  // Wrapped in a plain span, as the mockup draws it: the pill then sizes to its text, a little smaller than the search-result counts.
  const badge = fresh > 0
    ? <span><span className={cx("cnt", freshImports ? "imp" : "new")}>{fresh} new</span></span>
    : total > 0 ? <span><span className={c("cnt")}>{total}</span></span> : null;
  const appName = env.props.appInfo.name;
  return (
    <nav className={c("side")} aria-label="Settings sections">
      <div className={cx("search", searching && "has")}>
        <Icon name="search" className="si" />
        <input
          type="text" placeholder="Search settings" aria-label="Search settings" autoFocus={ui.focusSearch} value={ui.query}
          className={cx(searching || ui.focusSearch ? "f" : "")}
          onChange={(e) => env.patch({ query: e.target.value, selKey: null })}
          onKeyDown={(e) => { if (e.key === "Escape") env.patch({ query: "" }); }}
        />
        <button type="button" className={c("cl")} aria-label="Clear search" onClick={() => env.patch({ query: "" })}><Icon name="circle-x" /></button>
      </div>
      <div className={c("navwrap")}>
        <div className={c("grp")}>All apps</div>
        {top.map(item)}
        <div className={c("grp")}>{appName}</div>
        {own.map(item)}
      </div>
      <div className={c("sidefoot")}>
        {pinned.map((p) => (p.id === "changes"
          ? <NavItem key={p.id} item={p} selected={!searching && ui.section === p.id} badge={badge} />
          : <NavItem key={p.id} item={p} selected={!searching && ui.section === p.id} />))}
      </div>
    </nav>
  );
}

function Pane({ pages }: { pages: CustomPage[] }): ReactNode {
  const env = useEnv();
  const { ui } = env;
  let body: ReactNode;
  const page = pages.find((p) => p.id === ui.section);
  if (ui.query.trim()) body = <SearchPane query={ui.query} />;
  else if (page) body = (<><PaneHead icon={page.icon} title={page.label} /><div className={c("pscroll")}>{page.render()}</div></>);
  else if (ui.section === "changes") body = <ChangesPane />;
  else if (ui.section === "shortcuts") body = <ShortcutsPane />;
  else if (ui.section === "accounts") body = <AccountsPane />;
  else if (ui.section === "about") body = <AboutPane />;
  else body = <SectionPane section={ui.section} />;
  return (
    <main className={c("pane")}>
      {ui.notice ? (
        <div className={c("notice")} role="alert">
          <Icon name="circle-alert" /><span>{ui.notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => env.patch({ notice: null })}><Icon name="x" /></button>
        </div>
      ) : null}
      {body}
    </main>
  );
}

/** `initial` opens the window in a view state. It can never carry a key: a `keyDraft` from an older host is dropped here. */
function startState(props: SettingsWindowProps): UiState {
  const { keyDraft: _dropped, ...rest } = (props.initial ?? {}) as Partial<UiState> & { keyDraft?: unknown };
  const state = { ...initialUi(), ...rest };
  return hasPane(props.schema, props.customPages ?? [], state.section) ? state : { ...state, section: "general" };
}

const importBatches = (state: SettingsWindowProps["state"]): Set<string> =>
  new Set(state.changes.flatMap((e) => (e.who.kind === "import" && e.batch !== undefined ? [e.batch] : [])));

export function SettingsWindow(props: SettingsWindowProps): ReactNode {
  const now = props.now ?? Date.now();
  const [ui, setUi] = useState<UiState>(() => startState(props));
  const [localSeen, setLocalSeen] = useState(Number.NEGATIVE_INFINITY);
  /** While Changes is open: what counted as seen when it opened, so the "new" highlight lasts for the visit whatever the host stores meanwhile. */
  const [visitSeen, setVisitSeen] = useState<number | null>(() => (props.initial?.section === "changes" ? props.changesSeenAt ?? now : null));
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const propsRef = useRef(props);
  propsRef.current = props;
  const nowRef = useRef(now);
  nowRef.current = now;
  const localSeenRef = useRef(localSeen);
  localSeenRef.current = localSeen;
  const opener = useRef<HTMLElement | null>(null);
  const pendingImport = useRef<Set<string> | null>(null);
  const patch = useCallback((p: Partial<UiState>) => setUi((u) => ({ ...u, ...p })), []);

  const seenAt = ui.section === "changes" && visitSeen !== null ? visitSeen : Math.max(props.changesSeenAt ?? now, localSeen);
  const resolved = useMemo(() => props.registry.resolveBindings(props.state.keys).bindings, [props.registry, props.state.keys]);
  const ctx: Ctx = {
    schema: props.schema, state: props.state, registry: props.registry, now, seenAt, hints: props.rowHints ?? {},
    cli: props.appInfo.cli ?? props.schema.app, bindings: resolved, changed: changedSets(props.state, props.schema),
  };
  const pages = props.customPages ?? [];

  // Changes is "seen" when it opens and again when it is left, and the window may start on it or be closed on it.
  useEffect(() => {
    if (uiRef.current.section === "changes") propsRef.current.onChangesSeen?.(nowRef.current);
    return () => { if (uiRef.current.section === "changes") propsRef.current.onChangesSeen?.(nowRef.current); };
  }, []);

  const go = useCallback((wanted: string, p: Partial<UiState> = {}) => {
    const host = propsRef.current;
    const section = hasPane(host.schema, host.customPages ?? [], wanted) ? wanted : "general";
    const from = uiRef.current.section;
    const at = nowRef.current;
    if (from === "changes" && section !== "changes") { setVisitSeen(null); setLocalSeen(at); host.onChangesSeen?.(at); }
    else if (from !== "changes" && section === "changes") { setVisitSeen(Math.max(host.changesSeenAt ?? at, localSeenRef.current)); host.onChangesSeen?.(at); }
    setUi((u) => ({
      ...u, section, query: "", selKey: null, selChange: null, selItem: null, sheet: null, capturing: null, conflict: null, addingKey: null, notice: null, ...p,
    }));
  }, []);

  const run: Env["run"] = useCallback(async (fn) => {
    try {
      const r = await fn();
      if (r.ok) { if (uiRef.current.notice !== null) setUi((u) => ({ ...u, notice: null })); return true; }
      setUi((u) => ({ ...u, notice: r.error }));
    } catch (err) {
      setUi((u) => ({ ...u, notice: err instanceof Error ? err.message : "That did not work" }));
    }
    return false;
  }, []);

  // After an import succeeds: Changes, with the new batch selected. The batch is the one the host names, else the newest import
  // that was not there before (the host may only update `state` a moment after it returns).
  const applyImport: Env["applyImport"] = useCallback(async (preview: ImportPreview, fileName: string) => {
    const before = importBatches(propsRef.current.state);
    let batch: string | undefined;
    const ok = await run(async () => {
      const r = await propsRef.current.actions.importApply(preview, fileName);
      if (r.ok) batch = r.batch;
      return r;
    });
    if (!ok) return false;
    const latest = lastImportBatch(propsRef.current.state);
    const found = batch ?? (latest !== undefined && !before.has(latest) ? latest : undefined);
    go("changes", { selChange: found ?? null, filter: "all", changeText: "" });
    pendingImport.current = found === undefined ? before : null;
    return true;
  }, [go, run]);

  useEffect(() => {
    const before = pendingImport.current;
    if (!before) return;
    if (uiRef.current.section !== "changes") { pendingImport.current = null; return; }
    const latest = lastImportBatch(props.state);
    if (latest !== undefined && !before.has(latest)) { pendingImport.current = null; patch({ selChange: latest }); }
  }, [props.state, patch]);

  const copy = useCallback((text: string) => {
    if (props.onCopy) props.onCopy(text);
    else void navigator.clipboard?.writeText(text);
  }, [props]);

  const env: Env = {
    ctx, ui, patch, go, run, actions: props.actions, registry: props.registry, slots: props.slots ?? [], hints: ctx.hints, props, copy, opener, applyImport,
  };
  return (
    <EnvContext.Provider value={env}>
      <div
        className={`${c("root")}${props.className ? ` ${props.className}` : ""}`} data-section={ui.section}
        onFocus={(e) => { const t = e.target as HTMLElement; if (!t.closest('[role="dialog"]')) opener.current = t; }}
      >
        <div className={c("body")} {...(ui.sheet ? ({ inert: "" } as object) : {})}>
          <Sidebar pages={pages} />
          <Pane pages={pages} />
          <Inspector />
        </div>
        <Sheets />
      </div>
    </EnvContext.Provider>
  );
}
