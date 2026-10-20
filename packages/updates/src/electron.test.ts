import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createElectronFeedFetcher } from './electron.ts';

const identity = { appName: 'Example Editor', feedUrl: 'https://editor.example/updates.json' };
function fake(answer: 'success' | 'oversize' | 'redirect' | 'timeout' = 'success') {
  let options: unknown, partitions: unknown[] = [], headers: Record<string, string> = {}, aborted = false, requestCount = 0;
  const request = new EventEmitter() as EventEmitter & { setHeader(k: string, v: string): void; abort(): void; end(): void };
  request.setHeader = (k, v) => { headers[k] = v; };
  request.abort = () => { aborted = true; };
  request.end = () => queueMicrotask(() => {
    if (answer === 'timeout') return;
    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = answer === 'redirect' ? 302 : 200;
    request.emit('response', response);
    response.emit('data', Buffer.from(answer === 'oversize' ? 'x'.repeat(65537) : '{"schema":1}'));
    response.emit('end');
  });
  let timeout: (() => void) | undefined;
  const fetch = createElectronFeedFetcher(identity, {
    net: { request: (o) => { requestCount++; options = o; return request; } },
    session: { fromPartition: (...args) => { partitions = args; return {}; } },
    schedule: ((fn: () => void) => { timeout = fn; return 1; }) as never,
    cancel: (() => {}) as never
  });
  return { fetch, timeout: () => timeout?.(), facts: () => ({ options, partitions, headers, aborted, requestCount }) };
}
test('one GET uses an isolated non-persistent session, no cookies or redirects, and a fixed app name', async () => {
  const f = fake(); expect(await f.fetch()).toEqual({ ok: true, text: '{"schema":1}' });
  expect(f.facts()).toMatchObject({
    options: { url: identity.feedUrl, method: 'GET', credentials: 'omit', redirect: 'error' },
    partitions: ['app-patterns-updates', { cache: false }], headers: { 'User-Agent': 'Example Editor', Accept: 'application/json' }, requestCount: 1
  });
  expect(JSON.stringify(f.facts())).not.toContain('Cookie');
});
test('the read cap aborts oversized responses and redirects are never followed', async () => {
  for (const answer of ['oversize', 'redirect'] as const) {
    const f = fake(answer); expect((await f.fetch()).ok).toBe(false); expect(f.facts().aborted).toBe(true); expect(f.facts().requestCount).toBe(1);
  }
});
test('a timeout aborts the request without persisting a response', async () => {
  const f = fake('timeout'); const promise = f.fetch(); f.timeout();
  expect(await promise).toEqual({ ok: false, reason: 'unreachable' }); expect(f.facts().aborted).toBe(true);
});
