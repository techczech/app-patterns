import type { FeedAnswer } from './update-check.ts'
import { feedRequest } from './update-feed.ts'
import type { UpdateIdentity } from './options.ts'

interface ResponseLike {
  statusCode: number
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end' | 'error', listener: () => void): unknown
}
interface RequestLike {
  setHeader(name: string, value: string): void
  on(event: 'error', listener: () => void): unknown
  on(event: 'response', listener: (response: ResponseLike) => void): unknown
  end(): void
  abort(): void
}

/** Pass Electron's net and session. Its network stack uses the system proxy; this adapter never overrides it. */
export interface ElectronFeedDeps<S> {
  net: { request(options: { url: string; method: string; credentials: 'omit'; redirect: 'error'; session: S }): RequestLike }
  session: { fromPartition(partition: string, options: { cache: boolean }): S }
  /** Injectable clocks for headless timeout verification. */
  schedule?: typeof setTimeout
  cancel?: typeof clearTimeout
}

/** A single bounded GET. No storage partition, cookies, credentials, redirects, query or version parameter. */
export function createElectronFeedFetcher<S>(identity: UpdateIdentity, deps: ElectronFeedDeps<S>): () => Promise<FeedAnswer> {
  const spec = feedRequest(identity)
  let isolated: S | undefined
  const schedule = deps.schedule ?? setTimeout
  const cancel = deps.cancel ?? clearTimeout
  return () => new Promise((resolve) => {
    let finished = false
    let request: RequestLike | undefined
    const done = (answer: FeedAnswer): void => {
      if (finished) return
      finished = true
      cancel(timer)
      try { request?.abort() } catch { /* already closed */ }
      resolve(answer)
    }
    const timer = schedule(() => done({ ok: false, reason: 'unreachable' }), spec.timeoutMs)
    try {
      isolated ??= deps.session.fromPartition('app-patterns-updates', { cache: false })
      request = deps.net.request({ url: spec.url, method: spec.method, credentials: 'omit', redirect: 'error', session: isolated })
      for (const [name, value] of Object.entries(spec.headers)) request.setHeader(name, value)
      request.on('error', () => done({ ok: false, reason: 'unreachable' }))
      request.on('response', (response) => {
        if (response.statusCode !== 200) { done({ ok: false, reason: 'unreadable' }); return }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk) => {
          if (finished) return
          bytes += chunk.length
          if (bytes > spec.maxBytes) { done({ ok: false, reason: 'too-large' }); return }
          chunks.push(Buffer.from(chunk))
        })
        response.on('end', () => done({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', () => done({ ok: false, reason: 'unreachable' }))
      })
      request.end()
    } catch { done({ ok: false, reason: 'unreachable' }) }
  })
}
