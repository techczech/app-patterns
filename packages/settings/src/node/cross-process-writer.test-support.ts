/**
 * One writer process for the cross-process test: `bun cross-process-writer.test-support.ts <dir> <me> <startAt>`.
 * 200 sets, alternating its own keys (p<me>.k0 … k49, each written twice) and the shared key. Prints one JSON line of what it wrote.
 */
import { defineSchema, type SettingDef } from "../schema.ts";
import { commands } from "../fixture.test-support.ts";
import { SettingsStore } from "./settings-store.ts";

export const KEYS_PER_PROCESS = 50;
export const SETS = 200;

export const crossSchema = defineSchema({
  app: "crosstest",
  sections: [{ id: "load", label: "Load", icon: "activity" }],
  settings: [
    ...[0, 1].flatMap((p) =>
      Array.from({ length: KEYS_PER_PROCESS }, (_, k): SettingDef => ({ key: `p${p}.k${k}`, label: `p${p} k${k}`, section: "load", type: "number", default: 0, min: 0, max: 1e9 })),
    ),
    { key: "shared", label: "Shared", section: "load", type: "number", default: -1, min: -1, max: 1e9 },
  ],
});

/** What process `me` writes at step `j`. */
export function step(me: number, j: number): { key: string; value: number } {
  return j % 2 === 0 ? { key: `p${me}.k${(j / 2) % KEYS_PER_PROCESS}`, value: j + 1 } : { key: "shared", value: me * 10_000 + j };
}

if (import.meta.main) {
  const [dir, meText, startText] = process.argv.slice(2);
  const me = Number(meText);
  const store = new SettingsStore({ dir: dir!, app: "crosstest", schema: crossSchema, registry: commands, appVersion: "1", who: { kind: "agent", name: `p${me}` }, watch: false, log: () => {} });
  await store.ready;
  while (Date.now() < Number(startText)) await Bun.sleep(1);
  const failures: string[] = [];
  for (let j = 0; j < SETS; j++) {
    const { key, value } = step(me, j);
    const r = await store.set(key, value);
    if (!r.ok) failures.push(`${j}: ${r.code} ${r.error}`);
    else if (r.entries.length !== 1) failures.push(`${j}: ${r.entries.length} entries`);
  }
  await store.close();
  process.stdout.write(`${JSON.stringify({ me, failures })}\n`);
}
