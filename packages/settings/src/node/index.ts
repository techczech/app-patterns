/** `@app-patterns/settings/node`: the settings file on disk, its cross-process lock, the watched store, and the agent CLI. */
export { readBoundedFile, type BoundedRead } from "./bounded-read.ts";
export { acquireLock, LOCK_LEASE_MS, LOCK_WAIT_MS, LockTimeout, pidAlive, withLock, type Lock, type LockOptions } from "./lock.ts";
export {
  DAMAGED_KEPT, DEFAULT_FILE_MESSAGES, MAX_FILE_BYTES, SettingsFile, TEMP_MAX_AGE_MS,
  type FileErrorCode, type FileMessages, type FileRead, type SettingsFileOptions, type UpdateResult, type UpdateStep,
} from "./settings-file.ts";
export {
  SETTINGS_FILE_NAME, SettingsStore, WATCH_DEBOUNCE_MS, WATCH_MAX_WAIT_MS,
  type SettingsStoreOptions, type StoreErrorCode, type StoreMessages, type StoreProblem, type StoreResult, type StoreUndoResult,
} from "./settings-store.ts";
export { DEFAULT_AGENT, DEFAULT_CHANGES_LIMIT, EXIT, runSettingsCli, type SettingsCliIO, type SettingsCliOptions } from "./cli.ts";
