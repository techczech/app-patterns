/** Small text helpers: dates in the window's words, plurals, class names, ids. No logic about settings lives here. */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

const pad = (n: number): string => String(n).padStart(2, "0");
export const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export type DayGroup = "Today" | "Yesterday" | "Earlier";
/** Which of the Changes page's groups a time falls in. */
export function dayGroup(at: number, now: number): DayGroup {
  const today = startOfDay(now);
  if (at >= today) return "Today";
  const yesterday = new Date(new Date(today).getFullYear(), new Date(today).getMonth(), new Date(today).getDate() - 1).getTime();
  if (at >= yesterday) return "Yesterday";
  return "Earlier";
}

/** "Thu 15 Oct" (and the year when it is not this year). */
export function dateText(at: number, now: number): string {
  const d = new Date(at);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** The time of a change: "just now" within two minutes, then "Today 10:38", "Yesterday 16:20", "Thu 15 Oct". `bare` leaves the word off Today and Yesterday ("10:38"). */
export function whenText(at: number, now: number, bare = false): string {
  if (!bare && now - at >= 0 && now - at < 2 * 60_000) return "just now";
  const g = dayGroup(at, now);
  if (g === "Earlier") return dateText(at, now);
  return bare ? clock(at) : `${g} ${clock(at)}`;
}

/** The heading of the Earlier group: "Earlier in October" when everything in it is from this month, else "Earlier". */
export function earlierHeading(times: readonly number[], now: number): string {
  const n = new Date(now);
  const same = times.every((t) => new Date(t).getMonth() === n.getMonth() && new Date(t).getFullYear() === n.getFullYear());
  return same ? `Earlier in ${MONTHS_LONG[n.getMonth()]}` : "Earlier";
}

/** "Sat 17 Oct 2026 at 18:04" for an ISO time from an export file, with the year always. */
export function isoLong(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} at ${clock(ms)}`;
}

/** "Sat 17 Oct 18:04" for an ISO time from an export file. */
export function isoText(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${dateText(ms, now)} ${clock(ms)}` : undefined;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "5 settings and 1 shortcut" / "1 shortcut" / "3 settings". */
export function countText(settings: number, shortcuts: number): string {
  if (settings > 0 && shortcuts > 0) return `${plural(settings, "setting")} and ${plural(shortcuts, "shortcut")}`;
  return shortcuts > 0 ? plural(shortcuts, "shortcut") : plural(settings, "setting");
}

/** `c("row changed")` is "bsw-row bsw-changed": every class this package uses carries the prefix, so a host's own classes never collide. */
export const c = (names: string): string => names.split(" ").filter(Boolean).map((n) => `bsw-${n}`).join(" ");
export const cx = (...parts: (string | false | null | undefined)[]): string => c(parts.filter(Boolean).join(" "));

/** "go-to-heading" to "goToHeading". */
export const camel = (id: string): string => id.replace(/[-_.]+([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());

/** A lucide icon's kebab-case name to the export name ("pen-line" to "PenLine"). */
export const pascal = (name: string): string =>
  name.split(/[-_\s]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

/** The words of a search, for highlighting. */
export const wordsOf = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean);

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
