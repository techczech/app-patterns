import { test, expect } from "bun:test";
import { productionVaultOptions } from "./production.ts";
import { githubVisibilityCheck } from "./github-visibility.ts";
import type { HelperConfig, RegisteredVault } from "./config.ts";
import type { ProcessLauncher } from "../git-process.ts";
const vault = { id: "v", path: "/vault", scope: { include: ["**/*.md"] }, remote: "origin", github: { repository: "owner/repo", credentialMode: "host", repositoryId: 123 } } as RegisteredVault;
const config = { machineId: "machine", captureIntervalMs: 1000, vaults: [vault], tools: { git: "/git", gitleaks: "/gitleaks" } } as HelperConfig;
const raw: ProcessLauncher = () => { throw new Error("owned registry"); };
test("host mode without factory refuses instead of ambient fallback", () => {
  expect(() => productionVaultOptions(config, vault, raw)).toThrow("host credentials");
});
test("host factory wraps exact registry and supplies helpers and visibility", async () => {
  let received: unknown;
  const wrapped: ProcessLauncher = (...args) => raw(...args);
  const opts = productionVaultOptions(config, vault, raw, { hostCredentials(v, launch) {
    received = [v, launch];
    return { credential: async () => "synthetic", launch: wrapped, helpers: ["!fixed-entry"] };
  }, fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic");
    return Response.json({ id: 123, full_name: "owner/repo", private: true });
  }) as unknown as typeof fetch });
  expect(received).toEqual([vault, raw]);
  expect(opts.launch).toBe(wrapped);
  expect(opts.trustedCredentialHelpers).toEqual(["!fixed-entry"]);
  expect(opts.gitEnv?.GIT_CONFIG_KEY_1).toBe("http.followRedirects");
  expect(opts.gitEnv?.GIT_CONFIG_VALUE_1).toBe("false");
  expect(await opts.remoteVisibility!("https://github.com/owner/repo.git")).toBe("private");
});
test("numeric identity mismatch holds even when name agrees", async () => {
  const check = githubVisibilityCheck({ repository: "owner/repo", repositoryId: 123, credential: async () => "synthetic", fetch: (async () => Response.json({ id: 456, full_name: "owner/repo", private: true })) as unknown as typeof fetch });
  expect((await check("https://github.com/owner/repo.git")).visibility).toBe("unknown");
});

import { parseHelperConfig } from './config.ts';
import { startHelper } from './server.ts';
import { createProcessRegistry } from './process-registry.ts';
import { createBackupEngine } from '../engine.ts';
import { sandbox, permissiveGuards, isolatedGitEnv, git } from '../test-fixtures.ts';
import { join } from 'node:path';
import { previewVault, enableVault } from './enrol.ts';
const GIT = '/Library/Developer/CommandLineTools/usr/bin/git';
const LEAKS = '/opt/homebrew/bin/gitleaks';
test('config host mode requires numeric ID, rejects commands, preserves legacy', async () => {
  const b = sandbox();
  try {
    const value = { configVersion: 2, machineId: 'm', tools: { git: GIT, gitleaks: LEAKS }, vaults: [{ id: 'v', path: b.repo, include: ['**/*.md'], github: { repository: 'owner/repo', credentialMode: 'host', repositoryId: 123 } }] };
    expect((await parseHelperConfig(value)).vaults[0]!.github?.repositoryId).toBe(123);
    for (const repositoryId of [undefined, '123', 0, -1, 1.5]) await expect(parseHelperConfig({ ...value, vaults: [{ ...value.vaults[0], github: { ...value.vaults[0]!.github, repositoryId } }] })).rejects.toThrow();
    await expect(parseHelperConfig({ ...value, credentialHelper: '!code' })).rejects.toThrow();
  } finally { b.cleanup(); }
});
test('actual startHelper retains factory wrapper around its own registry and named history', async () => {
  const b = sandbox(); const processes = createProcessRegistry(); let wrapped: ProcessLauncher | undefined; let observed: ProcessLauncher | undefined;
  let handle: Awaited<ReturnType<typeof startHelper>> | undefined;
  try {
    const v = { ...vault, path: b.repo, history: 'test-history' };
    const c = { ...config, tools: { git: GIT, gitleaks: LEAKS }, vaults: [v] };
    handle = await startHelper({ config: c, processes, runtimeDir: join(b.dir, 'run'), maxRuntimeMs: 10000,
      projections: { 'test-history': () => ({ name: 'test-history', namespaces: ['.versions'], read: async () => ({ state: 'complete', files: [] }) }) },
      hostCredentials(_v, launch) {
        expect(launch).toBe(processes.launch); wrapped = (...args) => launch(...args);
        return { credential: async () => null, launch: wrapped, helpers: ['!fixed'] };
      },
      engineOptions: { ...permissiveGuards, gitPath: GIT, gitEnv: isolatedGitEnv },
      createEngine(_v, opts) { observed = opts.launch; return createBackupEngine({ ...opts, ...permissiveGuards }); }
    });
    expect(observed).toBe(wrapped); expect(observed).not.toBe(processes.launch);
  } finally { if (handle) await handle.stop('test'); await processes.end(); b.cleanup(); }
});
test('preview and enable use host identity and token, never a credential override', async () => {
  const b = sandbox(); const processes = createProcessRegistry();
  try {
    git(b.repo, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git']);
    const v = { ...vault, path: b.repo };
    const c = { ...config, tools: { git: GIT, gitleaks: LEAKS }, vaults: [v] };
    let calls = 0; let launches = 0;
    const deps = { launch: processes.launch, mountInfo: async () => null,
      credential: async () => { throw new Error('ambient forbidden'); },
      hostCredentials(_v: RegisteredVault, launch: ProcessLauncher) {
        expect(launch).toBe(processes.launch);
        return { credential: async ({path}: {path:string}) => { expect(path).toBe('owner/repo.git'); return 'same-synthetic'; }, launch: ((...args) => { launches++; return launch(...args); }) as ProcessLauncher, helpers: ['!fixed'] };
      },
      fetch: (async (_url: unknown, init?: RequestInit) => { calls++; expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer same-synthetic'); return Response.json({ id: 123, full_name: 'owner/repo', private: true }); }) as unknown as typeof fetch };
    expect((await previewVault(c, 'v', deps)).visibility).toBe('private');
    expect((await enableVault(c, 'v', {confirmPublic:false}, deps)).enabled).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2); expect(launches).toBeGreaterThan(0);
    await expect(previewVault(c, 'v', {launch: processes.launch})).rejects.toThrow('host credentials');
    deps.fetch = (async () => Response.json({id:999,full_name:'owner/repo',private:true})) as unknown as typeof fetch;
    expect((await previewVault(c,'v',deps)).visibility).toBe('unknown');
  } finally { await processes.end(); b.cleanup(); }
});

import { main } from './cli.ts';
import { writeFileSync } from 'node:fs';
test('actual CLI preview forwards host factory and refuses host config without it', async () => {
  const b = sandbox(); const stdout = process.stdout.write; let called = 0;
  try {
    git(b.repo, ['remote','set-url','origin','https://github.com/owner/repo.git']);
    const file = join(b.dir,'host-config.json');
    writeFileSync(file, JSON.stringify({configVersion:2,machineId:'m',tools:{git:GIT,gitleaks:LEAKS},vaults:[{id:'v',path:b.repo,include:['**/*.md'],github:vault.github}]}),{mode:0o600});
    process.stdout.write = (() => true) as typeof process.stdout.write;
    await expect(main(['preview','--config',file,'--vault','v'])).rejects.toThrow('host credentials');
    const code = await main(['preview','--config',file,'--vault','v'],{}, {hostCredentials(_v,launch){called++;return {credential:async()=>null,launch:(...args)=>launch(...args),helpers:['!fixed']}}});
    expect(code).toBe(0); expect(called).toBeGreaterThan(0);
  } finally { process.stdout.write = stdout; b.cleanup(); }
});
test('visibility lifetime abort cancels an outstanding request', async () => {
  const controller = new AbortController(); let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const pending = githubVisibilityCheck({repository:'owner/repo',repositoryId:123,credential:async()=> 'synthetic',signal:controller.signal,fetch:(async (_url:unknown,init?:RequestInit) => {
    started();return await new Promise<Response>((_r,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
  }) as unknown as typeof fetch})('https://github.com/owner/repo.git');
  await ready; controller.abort(); expect((await pending).visibility).toBe('unknown');
});
