/**
 * The `bridle-settings:` IPC channels and what travels on them. Shared by main and the preload, so it imports nothing from Node or
 * Electron. The prefix is reserved for the shared Settings host: an app must not handle or listen on a channel under it (`installSettings` refuses to start
 * when one is taken).
 * No channel carries a key's value towards a renderer: slots travel as status and last four characters only, and a key goes the other
 * way once, on `setSecret` (invariant 5). There is no channel that reads a key.
 */
import type { SettingsState } from "@app-patterns/settings";
import type { AppInfo, Slot } from "@app-patterns/settings-react";

/** Every Settings channel starts with this; the one place the name is spelt. */
export const CHANNEL_PREFIX = "bridle-settings:";

export const CHANNELS = {
  // renderer → main (invoke)
  view: `${CHANNEL_PREFIX}view`,
  set: `${CHANNEL_PREFIX}set`,
  rebind: `${CHANNEL_PREFIX}rebind`,
  rebindMany: `${CHANNEL_PREFIX}rebindMany`,
  reset: `${CHANNEL_PREFIX}reset`,
  resetSection: `${CHANNEL_PREFIX}resetSection`,
  resetAll: `${CHANNEL_PREFIX}resetAll`,
  resetEntry: `${CHANNEL_PREFIX}resetEntry`,
  undoBatch: `${CHANNEL_PREFIX}undoBatch`,
  export: `${CHANNEL_PREFIX}export`,
  importPreview: `${CHANNEL_PREFIX}importPreview`,
  importApply: `${CHANNEL_PREFIX}importApply`,
  setSecret: `${CHANNEL_PREFIX}setSecret`,
  removeSecret: `${CHANNEL_PREFIX}removeSecret`,
  choosePath: `${CHANNEL_PREFIX}choosePath`,
  // main → renderer (send)
  changed: `${CHANNEL_PREFIX}changed`,
  section: `${CHANNEL_PREFIX}section`,
} as const;

export type InvokeChannel = Exclude<(typeof CHANNELS)[keyof typeof CHANNELS], typeof CHANNELS.changed | typeof CHANNELS.section>;

/** Where the window should go: a section, and optionally an action to start there (Import Settings… from the menu). */
export interface SectionRequest {
  section: string;
  action?: "import";
}

/** Everything the Settings window shows, in one payload. Sent on `view` and pushed on `changed`. */
export interface SettingsView {
  state: SettingsState;
  /** Status and last four characters only; never a value. */
  slots: Slot[];
  appInfo: AppInfo;
  /** Why changes are refused (another app's file, a newer version's ...), when they are. */
  problem?: string;
  /** The section the window was opened at, and an action waiting for it. Delivered once, then cleared. */
  request?: SectionRequest;
}
