#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

export function extractRegistryPackages(lockText) {
  const found = new Map();

  for (const line of lockText.split("\n")) {
    const match = line.match(/^\s*"[^"]+": \["([^"]+)", "", /);
    if (!match) continue;

    const resolution = match[1];
    const separator = resolution.lastIndexOf("@");
    if (separator <= 0) continue;

    const name = resolution.slice(0, separator);
    const version = resolution.slice(separator + 1);
    if (!version || version.startsWith("file:") || version.startsWith("workspace:")) {
      continue;
    }

    found.set(`${name}@${version}`, { name, version });
  }

  return [...found.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

export function collectYoungPackages(packages, publishTimes, days, now = new Date()) {
  const thresholdMs = days * DAY_MS;
  const young = [];

  for (const pkg of packages) {
    const published = publishTimes.get(pkg.name)?.[pkg.version];
    if (!published) {
      throw new Error(
        `npm did not return a publish time for ${pkg.name}@${pkg.version}`,
      );
    }

    const ageMs = now.getTime() - new Date(published).getTime();
    if (ageMs < thresholdMs) {
      young.push({
        ...pkg,
        published,
        ageDays: Number((ageMs / DAY_MS).toFixed(2)),
      });
    }
  }

  return young.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

export function npmViewArguments(packageName, cachePath) {
  return ["view", packageName, "time", "--json", "--cache", cachePath];
}

async function npmPublishTimes(packageName, cachePath) {
  const { stdout } = await execFileAsync(
    "npm",
    npmViewArguments(packageName, cachePath),
    { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
  );
  return JSON.parse(stdout);
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function parseArguments(args) {
  let lockPath;
  let days = 7;
  let concurrency = 6;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--days") {
      days = Number(args[++index]);
    } else if (argument === "--concurrency") {
      concurrency = Number(args[++index]);
    } else if (!lockPath) {
      lockPath = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (!lockPath || !Number.isFinite(days) || days < 0) {
    throw new Error(
      "Usage: node scripts/lock-age-check.mjs <bun.lock> [--days N] [--concurrency N]",
    );
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new Error("Concurrency must be an integer from 1 to 20");
  }

  return { lockPath, days, concurrency };
}

async function main() {
  const { lockPath, days, concurrency } = parseArguments(process.argv.slice(2));
  const packages = extractRegistryPackages(await readFile(lockPath, "utf8"));
  const names = [...new Set(packages.map((pkg) => pkg.name))];
  const cachePath = join(tmpdir(), "app-patterns-lock-age-npm-cache");
  const times = await mapWithConcurrency(names, concurrency, async (name) => [
    name,
    await npmPublishTimes(name, cachePath),
  ]);
  const young = collectYoungPackages(packages, new Map(times), days);

  if (young.length === 0) {
    console.log(`No registry packages younger than ${days} days.`);
    return;
  }

  console.log(`Registry packages younger than ${days} days: ${young.length}`);
  console.log("package\tversion\tpublished\tage_days");
  for (const pkg of young) {
    console.log(`${pkg.name}\t${pkg.version}\t${pkg.published}\t${pkg.ageDays}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
