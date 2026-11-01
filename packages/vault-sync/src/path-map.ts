/**
 * Dictionaries keyed by a worktree path (write marks, pending floors, read blob ids). Any valid file name
 * is a key, `__proto__`, `constructor` and `toString` included. On an ordinary object, assigning
 * `__proto__` changes the object's prototype instead of storing an entry (JSON then drops it), and looking
 * up a name it does not hold finds an inherited value. So these maps are built without a prototype and read
 * through `own`, which never sees an inherited value. JSON, spread and structuredClone keep every own key.
 */
export type PathMap<T> = Record<string, T>;

/** A prototype-free copy of `from` (or an empty map): assignment always stores an own entry. */
export function pathMap<T>(from?: Readonly<Record<string, T>>): PathMap<T> {
  const map = Object.create(null) as PathMap<T>;
  if (from) for (const key of Object.keys(from)) map[key] = from[key]!;
  return map;
}

/** The entry `map` itself holds for `key`; never an inherited value. */
export function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}
