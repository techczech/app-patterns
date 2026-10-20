/** A working host for the demo: every action runs the real core operation on a local state. */
import {
  applyImport, previewImport, rebindMany, reset, resetAll, resetEntry, resetSection, set, undoBatch,
  type CommandsAdapter, type OpContext, type OpResult, type Schema, type SettingsState,
} from "@app-patterns/settings";
import { useMemo, useRef, useState } from "react";
import type { Outcome, SettingsActions, Slot } from "../src/types.ts";
import { IMPORT_FILE, wfImportFile } from "./fixture.ts";

export interface Store {
  state: SettingsState;
  slots: Slot[];
  now: number;
  actions: SettingsActions;
}

const outcome = (r: { ok: boolean; error?: string }): Outcome => (r.ok ? { ok: true } : { ok: false, error: r.error ?? "That did not work" });

export function useDemoStore(opts: { schema: Schema; commands: CommandsAdapter; state: SettingsState; slots: Slot[]; now: number }): Store {
  const [state, setState] = useState(opts.state);
  const [slots, setSlots] = useState(opts.slots);
  const [now, setNow] = useState(opts.now);
  const live = useRef({ state, now });
  live.current = { state, now };
  const actions = useMemo((): SettingsActions => {
    let n = 0;
    const ctx = (): OpContext => ({
      schema: opts.schema, who: { kind: "you" }, commands: opts.commands, now: () => live.current.now, newId: () => `d${Date.now().toString(36)}${n++}`,
    });
    const apply = (r: OpResult): Outcome => {
      if (r.ok) { setState(r.state); setNow((t) => t + 60_000); }
      return outcome(r);
    };
    return {
      set: (key, value) => apply(set(live.current.state, key, value, ctx())),
      rebind: (commandId, chord) => apply(rebindMany(live.current.state, [{ commandId, chord }], ctx())),
      rebindMany: (pairs) => apply(rebindMany(live.current.state, pairs, ctx())),
      reset: (target) => apply(reset(live.current.state, target, ctx())),
      resetSection: (id) => apply(resetSection(live.current.state, id, ctx())),
      resetAll: () => apply(resetAll(live.current.state, ctx())),
      resetEntry: (id) => apply(resetEntry(live.current.state, id, ctx())),
      undoBatch: (id) => apply(undoBatch(live.current.state, id, ctx())),
      exportSettings: () => ({ ok: true }),
      importPick: () => ({ fileName: IMPORT_FILE, preview: previewImport(live.current.state, wfImportFile(), { schema: opts.schema, commands: opts.commands }) }),
      importApply: (preview, fileName) => apply(applyImport(live.current.state, preview, { file: fileName }, ctx())),
      setSecret: (id) => { setSlots((s) => s.map((x) => (x.id === id ? { ...x, status: "connected", detail: "Key saved" } : x))); return { ok: true }; },
      removeSecret: (id) => { setSlots((s) => s.map((x) => (x.id === id ? { ...x, status: "missing", detail: "Not connected" } : x))); return { ok: true }; },
      signOut: (id) => { setSlots((s) => s.map((x) => (x.id === id ? { ...x, status: "missing", detail: "Signed out" } : x))); return { ok: true }; },
      choosePath: () => "~/Documents/Writing/Chosen",
      checkForUpdates: () => undefined,
    };
  }, [opts.schema, opts.commands]);
  return { state, slots, now, actions };
}
