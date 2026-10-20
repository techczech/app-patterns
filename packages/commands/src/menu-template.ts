/**
 * The app menu, generated from the command registry and the current bindings. Pure: Electron appears only as a local structural type,
 * so a test can read the result and the package needs no Electron dependency.
 *
 * Fixed frame: App (About, Settings…, Export Settings…, Import Settings…, app items, Hide/Quit) · Edit (roles + declared Edit groups) ·
 * declared app menus · View · Window · Help (cheat sheet, app items). Items show their chord but do not register it (`registerAccelerator: false`):
 * the window's own key handler runs the command, so a key is never handled twice.
 */
import { toAccelerator } from "./chords.ts";
import { FRAME_CHEAT_ID, FRAME_COMMAND_IDS, FRAME_EXPORT_SETTINGS, FRAME_IMPORT_SETTINGS, FRAME_SETTINGS_ID, type Bindings, type CommandDef, type FrameGroup, type Registry } from "./registry.ts";

/** The part of Electron's MenuItemConstructorOptions this package produces. Assignable to it. */
export interface MenuItem {
  label?: string;
  role?: "about" | "hide" | "hideOthers" | "unhide" | "quit" | "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "togglefullscreen" | "minimize" | "zoom" | "close";
  type?: "separator";
  accelerator?: string;
  registerAccelerator?: boolean;
  enabled?: boolean;
  click?: () => void;
  submenu?: MenuItem[];
}

/** A menu the app declares: the registry groups it shows, in order. Labels Edit, View, Window and Help add to the frame's menu of that name. */
export interface MenuDecl<G extends string> {
  label: string;
  groups: G[];
}

const FRAME_IDS: ReadonlySet<string> = new Set(FRAME_COMMAND_IDS);
const FRAME_LABELS = ["Edit", "View", "Window", "Help"] as const;

export interface MenuInput<G extends string, Ctx> {
  appName: string;
  registry: Registry<G, Ctx>;
  menus: MenuDecl<G>[];
  bindings: Bindings;
  run: (id: string) => void;
  /** The app's context for `available?(ctx)` (a void-context registry passes `undefined`). Rebuild the menu when it changes. */
  ctx: Ctx;
  /** Extra non-command items for the App and Help menus. */
  appItems?: { app?: MenuItem[]; help?: MenuItem[] };
}

const SEP: MenuItem = { type: "separator" };

/**
 * Ids of commands that would not appear in any menu: not `noMenu`, not placed by the frame, and in a group no menu declares.
 * Throws when two declared menus share a label (their groups would be silently dropped).
 */
export function validateMenuCoverage<G extends string, Ctx>(registry: Registry<G, Ctx>, menus: MenuDecl<G>[]): string[] {
  const labels = new Set<string>();
  for (const m of menus) {
    if (labels.has(m.label)) throw new Error(`Two menus are labelled "${m.label}"; declare each menu once`);
    labels.add(m.label);
  }
  const shown = new Set(menus.flatMap((m) => m.groups));
  return registry.defs.filter((d) => !d.noMenu && !FRAME_IDS.has(d.id) && !shown.has(d.group as G)).map((d) => d.id);
}

export function buildMenuTemplate<G extends string, Ctx>(input: MenuInput<G, Ctx>): MenuItem[] {
  const { appName, registry, menus, bindings, run, appItems, ctx } = input;
  const uncovered = validateMenuCoverage(registry, menus);
  const seenGroups = new Map<string, string>();
  for (const m of menus) {
    for (const g of m.groups) {
      if (!registry.groups.includes(g)) throw new Error(`Menu "${m.label}" lists unknown group "${g}"`);
      const prior = seenGroups.get(g);
      if (prior) throw new Error(`Group "${g}" is in both "${prior}" and "${m.label}"; a command lands in exactly one menu`);
      seenGroups.set(g, m.label);
    }
  }
  if (uncovered.length) throw new Error(`Commands in no menu: ${uncovered.join(", ")}`);

  const item = (d: CommandDef<G | FrameGroup, Ctx>): MenuItem => {
    const accelerator = toAccelerator(Object.hasOwn(bindings, d.id) ? bindings[d.id] ?? "" : "");
    let off = false;
    try { off = d.available !== undefined && d.available(ctx) !== null; } catch { off = true; }
    return { label: d.label, ...(accelerator ? { accelerator, registerAccelerator: false } : {}), ...(off ? { enabled: false } : {}), click: () => run(d.id) };
  };
  const frameItem = (id: string): MenuItem => item(registry.byId(id)!);
  const listed = (groups: readonly G[]): MenuItem[] =>
    registry.defs.filter((d) => groups.includes(d.group as G) && !d.noMenu && !FRAME_IDS.has(d.id)).map((d) => item(d));
  const declared = (label: string): MenuItem[] => {
    const m = menus.find((x) => x.label === label);
    return m ? listed(m.groups) : [];
  };
  const withLead = (lead: MenuItem[], extra: MenuItem[]): MenuItem[] => (extra.length ? [...lead, SEP, ...extra] : lead);

  const appMenu: MenuItem = {
    label: appName,
    submenu: [
      { role: "about" }, SEP,
      frameItem(FRAME_SETTINGS_ID),
      frameItem(FRAME_EXPORT_SETTINGS), frameItem(FRAME_IMPORT_SETTINGS),
      ...(appItems?.app?.length ? [SEP, ...appItems.app] : []),
      SEP, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, SEP, { role: "quit" },
    ],
  };
  const editMenu: MenuItem = {
    label: "Edit",
    submenu: withLead([{ role: "undo" }, { role: "redo" }, SEP, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }], declared("Edit")),
  };
  const appMenus: MenuItem[] = menus
    .filter((m) => !(FRAME_LABELS as readonly string[]).includes(m.label))
    .map((m) => ({ label: m.label, submenu: listed(m.groups) }));
  const viewMenu: MenuItem = { label: "View", submenu: [...declared("View"), ...(declared("View").length ? [SEP] : []), { role: "togglefullscreen" }] };
  const windowMenu: MenuItem = {
    label: "Window",
    submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }, ...(declared("Window").length ? [SEP, ...declared("Window")] : [])],
  };
  const helpMenu: MenuItem = {
    label: "Help",
    submenu: [frameItem(FRAME_CHEAT_ID), ...(appItems?.help ?? []), ...declared("Help")],
  };
  return [appMenu, editMenu, ...appMenus, viewMenu, windowMenu, helpMenu];
}
