import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ExportIncludes, SETTINGS_CSS, SettingsWindow } from "../src/index.ts";
import { Icon } from "../src/ui.tsx";
import { changedFromDefault } from "@app-patterns/settings";
import { FRAMES, frameNow, frameState, type Frame } from "./frames.ts";
import {
  FRAME_COMMANDS, twHints, twRegistry, twSchema, wfAdapter, wfCommandHelp, wfHints, wfMenus, wfRegistry, wfSchema, wfSlots,
} from "./fixture.ts";
import { useDemoStore } from "./store.ts";

const APPS = {
  editorexample: { name: "Example Editor", version: "0.31.4", build: "2810", icon: "pen-line", cli: "editorexample" },
  recorderexample: { name: "Example Recorder", version: "0.41.0", build: "1187", icon: "presentation", cli: "recorderexample" },
} as const;

function Menubar({ name, open }: { name: string; open?: boolean }): ReactNode {
  return (
    <div className="menubar">
      <span className={`m ap${open ? " open" : ""}`}>{name}</span>
      {["File", "Edit", "Format", "View", "Window", "Help"].map((m) => <span key={m} className="m">{m}</span>)}
      <span className="sp" /><span className="m">Mon 19 Oct 10:52</span>
    </div>
  );
}

function AppMenu({ name }: { name: string }): ReactNode {
  return (
    <>
      <div className="appmenu">
        <div>About {name}</div><hr />
        <div className="hl"><span>Settings…</span><span>⌘,</span></div>
        <div><span>Export Settings…</span><span /></div>
        <div><span>Import Settings…</span><span /></div><hr />
        <div className="dim"><span>Services</span><span>›</span></div><hr />
        <div><span>Hide {name}</span><span>⌘H</span></div>
        <div><span>Hide Others</span><span>⌥⌘H</span></div>
        <div className="dim"><span>Show All</span><span /></div><hr />
        <div><span>Quit {name}</span><span>⌘Q</span></div>
      </div>
      <div className="mainapp">
        <div className="tb"><div className="lights"><i /><i /><i /></div><div className="tt">Chapter 3 draft — {name}</div></div>
        <div className="doc"><div className="hd" />{Array.from({ length: 18 }, (_, i) => <div key={i} className="ln" style={{ width: i % 5 === 4 ? "60%" : "100%" }} />)}</div>
      </div>
    </>
  );
}

function SavePanel({ settings, shortcuts }: { settings: number; shortcuts: number }): ReactNode {
  return (
    <div className="d-scrim">
      <div className="bsw-sheet save">
        <div className="fl">
          <label>Save As:</label><div className="fld"><span className="selt">Example Editor Settings 2026-10-19</span>.json</div>
          <label>Tags:</label><div className="fld2" />
          <label>Where:</label><div className="pop"><Icon name="folder" />Documents<span className="cv"><Icon name="chevrons-up-down" /></span></div>
        </div>
        <ExportIncludes settings={settings} shortcuts={shortcuts} />
        <div className="bsw-acts"><button className="bsw-btn bsw-lg">Cancel</button><button className="bsw-btn bsw-lg bsw-pri">Save</button></div>
      </div>
    </div>
  );
}

function DemoWindow({ frame }: { frame: Frame }): ReactNode {
  const tw = frame.app === "recorderexample";
  const schema = tw ? twSchema : wfSchema;
  const registry = tw ? twRegistry : wfRegistry;
  const store = useDemoStore({ schema, commands: wfAdapter, state: frameState(frame), slots: tw ? [] : wfSlots(frame.speech), now: frameNow(frame) });
  const [seenAt, setSeenAt] = useState(frame.seenAt ?? frameNow(frame));
  const app = APPS[frame.app];
  const counts = changedFromDefault(store.state, schema);
  return (
    <>
      <Menubar name={app.name} />
      <div className="win">
        <div className="titlebar"><div className="lights"><i /><i /><i /></div><div className="tt">Settings</div></div>
        <SettingsWindow
          className="d-body" schema={schema} state={store.state} registry={registry} appInfo={app} actions={store.actions} slots={store.slots}
          rowHints={tw ? twHints : wfHints} menus={tw ? [] : wfMenus} commandHelp={tw ? {} : wfCommandHelp} now={store.now} changesSeenAt={seenAt}
          onChangesSeen={setSeenAt} appNames={{ recorderexample: "Example Recorder", editorexample: "Example Editor" }} initial={frame.initial}
          showCommand={(d) => !FRAME_COMMANDS.has(d.id) && !d.hidden}
          update={{ text: `${app.name} is up to date`, detail: "Last checked today at 09:41." }}
        />
        {frame.host === "save-panel" ? <SavePanel settings={counts.settings.length} shortcuts={counts.keys.length} /> : null}
      </div>
    </>
  );
}

function Demo(): ReactNode {
  const fromHash = (): number => { const n = parseInt(location.hash.slice(1), 10); return n >= 1 && n <= FRAMES.length ? n - 1 : 0; };
  const [i, setI] = useState(fromHash);
  useEffect(() => {
    (window as unknown as { __go: (n: number) => void; __frames: number }).__go = setI;
    (window as unknown as { __frames: number }).__frames = FRAMES.length;
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") setI((x) => (x + 1) % FRAMES.length);
      else if (e.key === "ArrowLeft") setI((x) => (x + FRAMES.length - 1) % FRAMES.length);
      else { const k = FRAMES.findIndex((f) => f.key === e.key.toLowerCase()); if (k >= 0) setI(k); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const frame = FRAMES[i]!;
  const app = APPS[frame.app];
  return (
    <div className="page">
      <style>{SETTINGS_CSS}</style>
      <div className="ident">
        <div className="badge">Built 19 Oct 2026</div>
        <div><div className="nm">Settings window — built to the example layout</div><div className="sub">@app-patterns/settings-react demo, fed by the real core. Keys 1–9 and 0 switch the first ten frames, Q W E R T Y the rest; ← and → step through all.</div></div>
      </div>
      <div className="fbar">
        {FRAMES.map((f, k) => <button key={f.key} className={k === i ? "on" : ""} onClick={() => setI(k)}><b>{f.key.toUpperCase()}</b>{f.name}</button>)}
      </div>
      <div className="stage" id="stage">
        {frame.host === "app-menu"
          ? <><Menubar name={app.name} open /><AppMenu name={app.name} /></>
          : <DemoWindow key={i} frame={frame} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Demo /></StrictMode>);
