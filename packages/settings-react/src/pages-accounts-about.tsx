import { AboutUpdatesCard, UpdatesProvider } from "@app-patterns/updates-react";
/** Accounts and keys (slots, never values) and About (version, update status, Reset all). */
import { changedFromDefault } from "@app-patterns/settings";
import { useRef, useState, type ReactNode } from "react";
import { c, countText, cx } from "./format.ts";
import { PaneHead, SettingCards } from "./pages-settings.tsx";
import { Btn, Icon, useEnv, useRowSelect } from "./ui.tsx";
import type { Slot } from "./types.ts";

const STATE = { connected: ["ok", "circle-check"], missing: ["no", "circle-dashed"], problem: ["bad", "circle-x"] } as const;

function statusText(s: Slot): string {
  if (s.detail) return s.detail;
  if (s.status === "connected") return s.kind === "account" ? "Signed in" : s.last4 ? `Connected · ends in ${s.last4}` : "Connected";
  if (s.status === "problem") return s.kind === "account" ? "Sign-in needs attention" : "Key not accepted";
  return "Not connected";
}

/**
 * The key is typed into an uncontrolled field that always starts empty (nothing can prefill it) and is cleared the moment it is
 * handed to the host, whether the save then succeeds or fails, so it is never held in the window's state or left in the page.
 */
function KeyForm({ slot, onSaved }: { slot: Slot; onSaved: () => void }): ReactNode {
  const env = useEnv();
  const ref = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const close = (): void => env.patch({ addingKey: null });
  const save = (): void => {
    const input = ref.current;
    const value = input?.value ?? "";
    if (!input || !value) return;
    input.value = "";
    setFilled(false);
    void env.run(() => env.actions.setSecret(slot.id, value)).then((ok) => { if (ok) { onSaved(); close(); } });
  };
  return (
    <div className={c("keyform")}>
      <div className={c("line")}>
        <input
          ref={ref} type="password" autoComplete="off" spellCheck={false} className={c("txt")} aria-label={`Key for ${slot.label}`} autoFocus
          onChange={(e) => setFilled(e.target.value !== "")}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") close(); }}
        />
        <Btn kind="pri" disabled={!filled} onClick={save}>Add key</Btn>
        <Btn onClick={close}>Cancel</Btn>
      </div>
    </div>
  );
}

function SlotRow({ slot }: { slot: Slot }): ReactNode {
  const env = useEnv();
  const [saved, setSaved] = useState(false);
  const [tone, icon] = STATE[slot.status];
  const adding = env.ui.addingKey === slot.id;
  const open = (): void => { setSaved(false); env.patch({ addingKey: slot.id, selItem: slot.id }); };
  const select = useRowSelect(env.ui.selItem === slot.id, () => env.patch({ selItem: slot.id }), () => env.patch({ selItem: env.ui.selItem === slot.id ? null : slot.id }));
  let acts: ReactNode;
  if (slot.kind === "account") {
    acts = slot.status === "connected" && env.actions.signOut ? <Btn onClick={() => { void env.run(() => env.actions.signOut!(slot.id)); }}>Sign out</Btn> : null;
  } else if (slot.status === "missing") {
    acts = adding ? null : <Btn kind="pri" onClick={open}>Add key…</Btn>;
  } else {
    acts = (
      <>
        <Btn kind={slot.status === "problem" ? "pri" : undefined} onClick={open}>{slot.status === "problem" ? <Icon name="refresh-cw" /> : null}Replace key…</Btn>
        <Btn kind="dng" onClick={() => { void env.run(() => env.actions.removeSecret(slot.id)); }}><Icon name="trash-2" />Remove</Btn>
      </>
    );
  }
  return (
    <div className={cx("svc", env.ui.selItem === slot.id && "sel")} data-slot={slot.id} {...select}>
      <div className={c("ic")}><Icon name={slot.icon ?? (slot.kind === "account" ? "bot" : "key-round")} /></div>
      <div className={c("mid")}>
        <div className={c("nm")}>{slot.label}</div>
        <div className={cx("stl", tone)}><Icon name={icon} />{statusText(slot)}</div>
        {adding ? <KeyForm slot={slot} onSaved={() => setSaved(true)} /> : null}
        {saved && !adding && slot.status === "connected" ? <div className={c("sv")}><Icon name="lock" />Saved in Keychain. The key is not shown again.</div> : null}
      </div>
      <div className={c("acts")}>{acts}</div>
    </div>
  );
}

export function AccountsPane(): ReactNode {
  const env = useEnv();
  const sec = env.ctx.schema.section("accounts");
  const groups = new Map<string, Slot[]>();
  for (const s of env.slots) {
    const g = s.group ?? (s.kind === "account" ? "Accounts" : "Services");
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const own = env.ctx.schema.settings.filter((d) => d.section === "accounts" && d.type !== "secret");
  return (
    <>
      <PaneHead icon={sec?.icon ?? "key-round"} title={sec?.label ?? "Accounts and keys"} />
      <div className={c("pscroll")}>
        {groups.size === 0 ? <div className={c("card")}><div className={c("empty")}><Icon name="key-round" /><h2>No accounts or keys</h2><p>This app has nothing to sign in to.</p></div></div> : null}
        {[...groups].map(([name, slots]) => (
          <div key={name} className={c("card")}>
            <div className={c("ch")}>{name}</div>
            {slots.map((s) => <SlotRow key={s.id} slot={s} />)}
          </div>
        ))}
        {own.length ? <SettingCards settings={own} fallbackGroup="Settings" /> : null}
      </div>
    </>
  );
}

export function AboutPane(): ReactNode {
  const env = useEnv();
  const { appInfo, update } = env.props;
  const richUpdate = update && "snapshot" in update ? update : undefined;
  const legacyUpdate = update && !("snapshot" in update) ? update : undefined;
  const count = changedFromDefault(env.ctx.state, env.ctx.schema);
  const version = `Version ${appInfo.version}${appInfo.build ? ` (build ${appInfo.build})` : ""}`;
  const sec = env.ctx.schema.section("about");
  return (
    <>
      <PaneHead icon={sec?.icon ?? "info"} title={sec?.label ?? "About"} />
      <div className={c("pscroll")}>
        {!richUpdate ? <div className={c("card")}>
          <div className={c("ch")}>Version</div>
          <div className={c("abouthead")}>
            <div className={c("ap")}><Icon name={appInfo.icon ?? "app-window"} /></div>
            <div className={c("grow")}><b>{appInfo.name}</b><div className={c("sub")}>{version}</div></div>
            <Btn onClick={() => env.copy(`${appInfo.name} ${version.replace("Version ", "")}`)}><Icon name="copy" />Copy version</Btn>
          </div>
        </div> : null}
        {richUpdate ? <UpdatesProvider {...richUpdate}><AboutUpdatesCard /></UpdatesProvider> : null}
        {legacyUpdate ? (
          <div className={c("card")}>
            <div className={c("ch")}>Updates</div>
            <div className={c("row")}>
              <div className={c("lab")}>
                <div className={cx("t", legacyUpdate.tone === "problem" ? "bad" : legacyUpdate.tone === "info" ? "info" : "okay")}><Icon name={legacyUpdate.tone === "problem" ? "circle-x" : legacyUpdate.tone === "info" ? "circle-arrow-down" : "circle-check"} />{legacyUpdate.text}</div>
                {legacyUpdate.detail ? <div className={c("h")}>{legacyUpdate.detail}</div> : null}
              </div>
              {env.actions.checkForUpdates ? <div className={c("ctl")}><Btn onClick={() => { void env.actions.checkForUpdates?.(); }}><Icon name="refresh-cw" />Check for updates</Btn></div> : null}
            </div>
          </div>
        ) : null}
        <div className={c("card")}>
          <div className={c("ch")}>Reset</div>
          <div className={c("row")}>
            <div className={c("lab")}>
              <div className={c("t")}>Reset all settings</div>
              <div className={c("h")}>{count.count === 0 ? "Every setting and shortcut has its default." : `${countText(count.settings.length, count.keys.length)} differ from their defaults.`}</div>
            </div>
            <div className={c("ctl")}><Btn kind="dng" disabled={count.count === 0} onClick={() => env.patch({ sheet: { kind: "reset-all" } })}><Icon name="rotate-ccw" />Reset all settings…</Btn></div>
          </div>
        </div>
      </div>
    </>
  );
}
