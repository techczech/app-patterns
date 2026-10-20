#!/usr/bin/env bun
// Runs a named script (build, typecheck, check, test, ...) in every workspace package
// that defines it, in dependency order, stopping at the first failure.
// `bun run --filter '*' <script>` runs packages in parallel, so a package can start
// before the @app-patterns/* packages it imports have written their dist output.
// `--sequential` runs them alphabetically, which is not dependency order either.
// Usage: bun run scripts/run-workspaces.mjs <script>

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(root, "packages");
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export function buildOrder(manifests) {
  const names = new Set(manifests.map((m) => m.name));
  const pending = new Map(
    manifests.map((m) => [
      m.name,
      new Set(
        DEP_FIELDS.flatMap((field) => Object.keys(m[field] ?? {})).filter(
          (dep) => names.has(dep) && dep !== m.name,
        ),
      ),
    ]),
  );
  const order = [];
  while (pending.size > 0) {
    const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) {
      throw new Error(`Workspace dependency cycle among: ${[...pending.keys()].sort().join(", ")}`);
    }
    for (const name of ready) {
      order.push(name);
      pending.delete(name);
    }
    for (const deps of pending.values()) {
      for (const name of ready) deps.delete(name);
    }
  }
  return order;
}

export function planRun(manifests, script) {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  return buildOrder(manifests).filter((name) => byName.get(name).scripts?.[script]);
}

export function runOrdered(workspaces, script, run) {
  for (const name of planRun(workspaces.map((w) => w.manifest), script)) {
    const workspace = workspaces.find((w) => w.manifest.name === name);
    console.log(`\n==> ${name} (${script})`);
    const status = run(workspace, script);
    if (status !== 0) return { ok: false, failed: name, status: status ?? 1 };
  }
  return { ok: true };
}

function readWorkspaces() {
  const found = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    found.push({ dir, manifest: JSON.parse(readFileSync(file, "utf8")) });
  }
  return found;
}

function main() {
  const script = process.argv[2];
  if (!script) {
    console.error("usage: run-workspaces.mjs <script>");
    process.exit(2);
  }
  const result = runOrdered(readWorkspaces(), script, (workspace, name) =>
    spawnSync(process.execPath, ["run", name], { cwd: workspace.dir, stdio: "inherit" }).status,
  );
  if (!result.ok) {
    console.error(`${script} failed in ${result.failed}`);
    process.exit(result.status);
  }
}

if (import.meta.main) main();
