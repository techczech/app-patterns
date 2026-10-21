import { describe, expect, test } from 'bun:test';
import { compareVersions, validateFeed, feedRequest, readUpdateState, availableMark, noteLaunch, whatsNewMark, answerView, createUpdateChecker, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS } from './index.ts';

const identity = { appName: 'Example Editor', feedUrl: 'https://editor.example/updates.json', storeName: 'Example Store' };
const latest = { version: '1.2.0', released: '2026-10-21', summary: ['One change.'], notes: 'https://editor.example/notes', download: { mac: 'https://editor.example/download#mac', windows: 'https://editor.example/download#windows' } };
const text = (value: unknown = latest) => JSON.stringify({ schema: 1, latest: value });
const context = { identity, running: '1.1.0', platform: 'darwin', source: 'website' as const, enabled: true, checking: false, now: 1000 };

describe('feed and version seam', () => {
  test('accepts only a whole valid same-site release feed', () => {
    expect(validateFeed(text(), identity.feedUrl)).toEqual({ ok: true, latest });
    for (const change of [{ version: '1.2.0-preview.1' }, { released: '2026-02-30' }, { summary: ['<b>Hi</b>'] }, { summary: ['x'.repeat(121)] }, { summary: [] }, { notes: 'https://evil.example/notes' }, { download: { ...latest.download, mac: 'https://editor.example.evil.test/' } }]) {
      expect(validateFeed(text({ ...latest, ...change }), identity.feedUrl).ok).toBe(false);
    }
    for (const bad of ['<html>Login</html>', 'x'.repeat(65537), JSON.stringify({ schema: 2, latest })]) expect(validateFeed(bad, identity.feedUrl).ok).toBe(false);
  });
  test('compares prereleases below their public release, and orders versions', () => {
    expect(compareVersions('1.2.0-preview.3', '1.2.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
    expect(compareVersions('1.2.0-alpha.2', '1.2.0-alpha.10')).toBe(-1);
  });
  test('builds a bare fixed-identity request and refuses query strings and credentials', () => {
    expect(feedRequest(identity)).toMatchObject({ url: identity.feedUrl, method: 'GET', headers: { 'User-Agent': 'Example Editor' }, timeoutMs: 10000, maxBytes: 65536 });
    for (const feedUrl of ['https://editor.example/updates.json?v=1', 'https://user@editor.example/updates.json', 'http://editor.example/updates.json']) expect(() => feedRequest({ ...identity, feedUrl })).toThrow();
  });
  test('persisted feed entries are revalidated for this app', () => {
    expect(readUpdateState({ latest }, identity.feedUrl).latest).toEqual(latest);
    expect(readUpdateState({ latest }, 'https://other.example/updates.json').latest).toBeUndefined();
  });
});

function harness(source: 'website' | 'store' | 'development' = 'website') {
  let now = 1000, state = {}, enabled = true, busy = false, requests = 0;
  const notifications: boolean[] = [];
  const requestBusyStates: boolean[] = [];
  const timers: { fn: () => void; ms: number; cancelled?: boolean }[] = [];
  const checker = createUpdateChecker({
    identity, running: '1.1.0', platform: 'darwin', source, readState: () => state, writeState: (value) => { state = value; },
    enabled: () => enabled, isBusy: () => busy, hasNotes: () => true, hadConfiguration: () => false,
    now: () => now, changed: (snap) => { notifications.push(snap.checking); }, fetchFeed: async () => { requestBusyStates.push(busy); requests++; return { ok: true, text: text() }; },
    schedule: ((fn: () => void, ms: number) => { const t = { fn, ms }; timers.push(t); return t; }) as never,
    cancel: ((t: { cancelled?: boolean }) => { t.cancelled = true; }) as never
  });
  return { checker, timers, notifications, requestBusyStates, requests: () => requests, state: () => state, busy: (v: boolean) => { busy = v; }, enabled: (v: boolean) => { enabled = v; }, advance: (ms: number) => { now += ms; }, tick: async () => { timers.filter(t => !t.cancelled).at(-1)?.fn(); await new Promise(r => setTimeout(r, 0)); } };
}

describe('checker and state seam', () => {
  test('delays the first check, checks daily and skips a recent successful check', async () => {
    const h = harness(); h.checker.start();
    expect(h.requests()).toBe(0); expect(h.timers[0]?.ms).toBe(FIRST_CHECK_DELAY_MS);
    await h.tick(); expect(h.requests()).toBe(1);
    await h.tick(); expect(h.requests()).toBe(1);
    h.advance(CHECK_INTERVAL_MS); await h.tick(); expect(h.requests()).toBe(2);
    h.checker.stop();
  });
  test('Store and development copies never fetch, even manually', async () => {
    for (const source of ['store', 'development'] as const) {
      const h = harness(source); h.checker.start(); await h.checker.checkNow(); expect(h.requests()).toBe(0); expect(h.timers.length).toBe(0);
    }
  });
  test('busy checks wait, then run when the app becomes idle', async () => {
    const h = harness(); h.busy(true); h.checker.start(); await h.tick(); await h.checker.checkNow(); expect(h.requests()).toBe(0);
    h.busy(false); h.checker.busyChanged(); await new Promise(r => setTimeout(r, 0)); expect(h.requests()).toBe(1); h.checker.stop();
  });
  test('manual checking works with daily checking off', async () => {
    const h = harness(); h.enabled(false); h.checker.start(); await h.tick(); expect(h.requests()).toBe(0);
    await h.checker.checkNow(); expect(h.requests()).toBe(1); h.checker.stop();
  });
  test('skip affects one version and Not now ends at the next successful check', async () => {
    const h = harness(); await h.checker.checkNow(); expect(h.checker.snapshot().mark?.version).toBe('1.2.0');
    h.checker.skip('1.2.0'); expect(h.checker.snapshot().mark).toBeNull();
    h.checker.stopSkipping(); h.checker.notNow(); expect(h.checker.snapshot().mark).toBeNull();
    await h.checker.checkNow(); expect(h.checker.snapshot().mark?.version).toBe('1.2.0');
    expect(availableMark({ latest, skippedVersion: '1.1.5' }, context)).toEqual(latest);
  });
  test('all four deliberate answers use injected app and Store names', () => {
    expect(answerView({}, context).title).toBe('You have the newest version.');
    expect(answerView({ latest }, context).title).toBe('Example Editor 1.2.0 is available.');
    expect(answerView({ lastResult: 'unreadable' }, context).title).toBe('Could not check for updates.');
    expect(answerView({}, { ...context, source: 'store' }).title).toBe('Updates come from the Example Store.');
  });
  test('notes are offered after upgrades and legacy adoption, not first install or downgrades; clicking clears the mark', () => {
    expect(whatsNewMark(noteLaunch({}, '1.1.0', 1000, false), '1.1.0')).toBeNull();
    expect(whatsNewMark(noteLaunch({}, '1.1.0', 1000, true), '1.1.0')).not.toBeNull();
    expect(whatsNewMark(noteLaunch({ lastVersionRun: '1.2.0' }, '1.1.0', 1000, true), '1.1.0')).toBeNull();
    let s = noteLaunch({ lastVersionRun: '1.0.0' }, '1.1.0', 1000, true);
    expect(whatsNewMark(s, '1.1.0')).not.toBeNull();
    for (let day = 1; day <= 7; day++) s = noteLaunch(s, '1.1.0', 1000 + day * CHECK_INTERVAL_MS, true);
    expect(whatsNewMark(s, '1.1.0')).toBeNull();
  });
});

test('subscribers see checking start and simultaneous checks share one request', async () => {
  const h = harness();
  await Promise.all([h.checker.checkNow(), h.checker.checkNow()]);
  expect(h.requests()).toBe(1);
  expect(h.notifications[0]).toBe(true);
  expect(h.notifications.at(-1)).toBe(false);
});

test('entering busy mode immediately after asking never starts a request while busy', async () => {
  const h = harness();
  const pending = h.checker.checkNow();
  h.busy(true); h.checker.busyChanged();
  await pending;
  expect(h.requestBusyStates).not.toContain(true);
  h.checker.stop();
});


test('unsafe schemes are rejected in every feed link', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/update', 'data:text/html,update', 'http://editor.example/download']) {
    for (const change of [{ notes: url }, { download: { ...latest.download, mac: url } }, { download: { ...latest.download, windows: url } }]) {
      expect(validateFeed(text({ ...latest, ...change }), identity.feedUrl).ok).toBe(false);
    }
  }
});

test('Mac copy facts distinguish Apple silicon and Intel', async () => {
  const { aboutLines } = await import('./index.ts');
  expect(aboutLines({ ...context, arch: 'arm64' }).where).toContain('Mac (Apple silicon)');
  expect(aboutLines({ ...context, arch: 'x64' }).where).toContain('Mac (Intel)');
  const h = harness();
  expect(h.checker.snapshot().arch).toBe(process.arch);
});

test('guarded opener binds identity, validates stored feed and never accepts caller URLs', async () => {
  const { createUpdateLinkOpener } = await import('./electron.ts');
  const opened: string[] = [];
  let release: unknown = latest;
  const open = createUpdateLinkOpener({ openExternal: async url => { opened.push(url); } }, { ...identity, storeUrl: 'https://store.example/editor' }, () => release, 'darwin');
  expect(await open('download')).toBe(true);
  expect(await open('notes', '1.2.0')).toBe(true);
  expect(await open('notes', '1.1.0')).toBe(false);
  expect(await open('store')).toBe(true);
  expect(await open('https://evil.example' as never)).toBe(false);
  release = { ...latest, notes: 'https://evil.example/notes' };
  expect(await open('download')).toBe(false);
  for (const storeUrl of ['javascript:alert(1)', 'file:///tmp/update', 'data:text/html,update', 'http://store.example/editor', 'https://user@store.example/editor']) {
    expect(await createUpdateLinkOpener({ openExternal: async () => { throw Error('must not open'); } }, { ...identity, storeUrl }, () => latest)('store')).toBe(false);
  }
  expect(opened).toEqual([latest.download.mac, latest.notes, 'https://store.example/editor']);
  expect(await createUpdateLinkOpener({ openExternal: async () => { throw Error('browser unavailable'); } }, identity, () => latest)('notes')).toBe(false);
});
