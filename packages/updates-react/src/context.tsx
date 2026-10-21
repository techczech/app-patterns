import { createContext, useContext, type ReactNode } from 'react'
import { answerView, type UpdateSnapshot, type WhatsNewItem, type AnswerView } from '@app-patterns/updates'

export interface UpdateActions {
  check(): Promise<UpdateSnapshot>
  setEnabled(on: boolean): Promise<unknown>
  download(): Promise<unknown>
  notNow(): Promise<unknown>
  skip(version: string): Promise<unknown>
  stopSkipping(): Promise<unknown>
  openNotes(version: string): Promise<unknown>
  openStore(): Promise<unknown>
  dismissWhatsNew(): Promise<unknown>
  /** Reads the notes shipped inside the app; never fetches them from the network. */
  loadNotes(version: string): Promise<WhatsNewItem[] | null>
  showNotes(version: string, items: WhatsNewItem[]): void
}
export interface UpdatesProps { snapshot: UpdateSnapshot; actions: UpdateActions }
const Context = createContext<UpdatesProps | null>(null)
export function UpdatesProvider({ snapshot, actions, children }: UpdatesProps & { children?: ReactNode }) {
  return <Context.Provider value={{ snapshot, actions }}>{children}</Context.Provider>
}
export function useUpdates(): UpdatesProps {
  const value = useContext(Context)
  if (!value) throw new Error('Update notices require UpdatesProvider.')
  return value
}
export const viewContext = (snap: UpdateSnapshot) => ({
  identity: snap.identity, running: snap.running, platform: snap.platform, arch: snap.arch, source: snap.source,
  enabled: snap.enabled, checking: snap.checking, now: Date.now()
})
export const answerOf = (snap: UpdateSnapshot): AnswerView => snap.waiting
  ? { tone: 'plain', title: `${snap.identity.appName} will check when your task ends.`, detail: 'Nothing is sent while the app is busy.', action: null }
  : answerView(snap.state, viewContext(snap))
export async function openLocalNotes(snapshot: UpdateSnapshot, actions: UpdateActions): Promise<void> {
  const items = await actions.loadNotes(snapshot.running)
  if (items) actions.showNotes(snapshot.running, items)
}
