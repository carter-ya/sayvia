import { browser } from 'wxt/browser';
import { SessionSchema, type TaskSession } from '../runtime/task-protocol';

const ROOT = 'sayvia.tasks';
export interface TaskStorage {
  read(): Promise<TaskSession>;
  write(state: TaskSession): Promise<void>;
}
export const taskStorage: TaskStorage = {
  async read() {
    await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const stored = (await browser.storage.session.get(ROOT))[ROOT];
    return stored === undefined
      ? { version: 1, routes: [], canceled: [], manual: [] }
      : SessionSchema.parse(stored);
  },
  async write(state) {
    await browser.storage.session.set({ [ROOT]: SessionSchema.parse(state) });
  },
};
