import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import type { UpdateSnapshot } from '@app-patterns/updates';
import { UpdatesProvider, UpdateStatusMark, WhatsNewMark, AboutUpdatesCard, type UpdateActions } from './index.ts';
import { installDom } from './test-dom.ts';
let restore: () => void;
beforeEach(() => { restore = installDom(); });
afterEach(() => { cleanup(); restore(); });
const latest = { version: '1.2.0', released: '2026-10-21', summary: ['One change.'], notes: 'https://editor.example/notes', download: { mac: 'https://editor.example/download#mac', windows: 'https://editor.example/download#windows' } };
const snapshot = (): UpdateSnapshot => ({ identity: { appName: 'Example Editor', feedUrl: 'https://editor.example/updates.json', storeName: 'Example Store' }, running: '1.1.0', platform: 'darwin', source: 'website', enabled: true, checking: false, busy: false, waiting: false, state: { latest, lastResult: 'newer' }, mark: latest, whatsNew: { version: '1.1.0', from: '1.0.0' } });
function mount(part: 'mark' | 'notes' | 'about', snap = snapshot()) {
  const calls: string[] = [];
  const actions: UpdateActions = {
    check: async () => { calls.push('check'); return snap; }, setEnabled: async () => { calls.push('toggle'); }, download: async () => { calls.push('download'); },
    notNow: async () => { calls.push('not-now'); }, skip: async (v) => { calls.push('skip:' + v); }, stopSkipping: async () => { calls.push('stop-skipping'); },
    openNotes: async () => { calls.push('notes-link'); }, openStore: async () => { calls.push('store'); }, dismissWhatsNew: async () => { calls.push('seen'); },
    loadNotes: async () => [{ title: null, text: 'A local note.' }], showNotes: () => { calls.push('show-notes'); }
  };
  const child = part === 'mark' ? <UpdateStatusMark /> : part === 'notes' ? <WhatsNewMark /> : <AboutUpdatesCard />;
  return { ...render(<UpdatesProvider snapshot={snap} actions={actions}>{child}</UpdatesProvider>), calls };
}
test('the status mark opens a popover with Download, Not now and Skip this version', () => {
  const m = mount('mark'); fireEvent.click(m.getByRole('button', { name: '1.2.0 is available' }));
  fireEvent.click(m.getByRole('button', { name: 'Download from editor.example' })); expect(m.calls).toEqual(['download']);
  fireEvent.click(m.getByRole('button', { name: '1.2.0 is available' })); fireEvent.click(m.getByRole('button', { name: 'Not now' })); expect(m.calls.at(-1)).toBe('not-now');
  fireEvent.click(m.getByRole('button', { name: '1.2.0 is available' })); fireEvent.click(m.getByRole('button', { name: 'Skip this version' })); expect(m.calls.at(-1)).toBe('skip:1.2.0');
});
test('busy and Store copies show no available mark', () => {
  for (const snap of [{ ...snapshot(), busy: true }, { ...snapshot(), source: 'store' as const }]) {
    const m = mount('mark', snap); expect(m.queryByText('1.2.0 is available')).toBeNull(); m.unmount();
  }
});
test('clicking What’s new marks it seen and opens only injected local notes', async () => {
  const m = mount('notes');
  await act(async () => { fireEvent.click(m.getByRole('button')); await Promise.resolve(); });
  expect(m.calls).toEqual(['seen', 'show-notes']);
});
test('the Settings card exposes the privacy statement, daily switch, and manual check', async () => {
  const m = mount('about');
  expect(m.getByText(/internet address/).textContent).toContain('editor.example');
  fireEvent.click(m.getByRole('switch')); expect(m.calls).toContain('toggle');
  await act(async () => { fireEvent.click(m.getByRole('button', { name: 'Check for updates' })); });
  expect(m.calls).toContain('check');
});
test('the Store Settings card has no daily switch and opens the injected Store', async () => {
  const m = mount('about', { ...snapshot(), source: 'store' });
  expect(m.queryByRole('switch')).toBeNull(); fireEvent.click(m.getByRole('button', { name: 'Open in Example Store' })); expect(m.calls).toEqual(['store']); await act(async () => { await Promise.resolve(); });
});

test('the Settings card never claims success for a deferred busy check', async () => {
  const m = mount('about', { ...snapshot(), busy: true, waiting: true, state: {}, mark: null });
  await act(async () => { fireEvent.click(m.getByRole('button', { name: 'Check for updates' })); });
  expect(m.queryByText('You have the newest version.')).toBeNull();
  expect(m.getByText('Example Editor will check when your task ends.')).not.toBeNull();
});
