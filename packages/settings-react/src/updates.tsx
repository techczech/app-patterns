/** Opt-in rich update card. The base Settings entry point has no update-package imports. */
import { AboutUpdatesCard, UpdatesProvider, type UpdatesProps } from '@app-patterns/updates-react';
export function SettingsUpdatesCard(props: UpdatesProps) {
  return <UpdatesProvider {...props}><AboutUpdatesCard /></UpdatesProvider>;
}
