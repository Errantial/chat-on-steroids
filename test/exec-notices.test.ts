import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const processes = vi.hoisted(() => new Map<number, number | null>());
const terminateProcess = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/main/codex/manager.js', () => ({ unifiedExecManager: {
  setProcessReleaseListener: () => {},
  setProcessChangeListener: () => {},
  terminateProcess,
  listProcesses: () => [...processes]
    .filter(([, exit]) => exit === null)
    .map(([processId]) => ({ processId, incarnation: processId + 500, command: 'command-' + processId, cwd: '/repo', pid: processId + 1000, tty: false, startedAt: 900_000 + processId })),
  backgroundState: (owned: Set<number>) => ({
    running: [...processes].filter(([id, exit]) => owned.has(id) && exit === null).map(([id]) => id),
    exitedUnread: [...processes].filter(([id, exit]) => owned.has(id) && exit !== null).map(([processId, exitCode]) => ({ processId, exitCode }))
  })
} }));
import {
  backgroundExecObligations, backgroundExecRecoveryNotices, forgetExecOwner, noteExecOwner, noteExecAttended,
  resetExecOwnershipForTests, runningExecProcesses, stopExecProcess, UNATTENDED_EXEC_NOTICE_MS
} from '../src/main/codex/ownership.js';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); processes.clear(); terminateProcess.mockClear(); resetExecOwnershipForTests(); });
afterEach(() => { vi.useRealTimers(); });
function process(id = 10, exit: number | null = null, owner = 'session-a') {
  processes.set(id, exit); noteExecOwner(id, owner);
}
const publication = () => ({ completedAt: null as number | null, failed: false });
const notice = (response = publication(), owner = 'session-a') => backgroundExecRecoveryNotices(owner, response);
it('leaves completed output to the process delivery owner', () => {
  process(10, 7);
  expect(notice()).toEqual([]);
  expect(backgroundExecObligations('session-a').exitedUnread).toEqual([{ processId: 10, exitCode: 7 }]);
});
it('projects only live processes owned by the requested durable session', () => {
  process(10, null, 'session-a');
  process(11, null, 'session-b');
  process(12, 0, 'session-a');
  expect(runningExecProcesses('session-a')).toEqual([{
    processId: 10,
    incarnation: 510,
    command: 'command-10',
    startedAt: 900_010,
    tty: false
  }]);
  expect(backgroundExecObligations('session-a')).toMatchObject({ running: [10], exitedUnread: [{ processId: 12, exitCode: 0 }] });
  expect(backgroundExecObligations('session-b')).toMatchObject({ running: [11], exitedUnread: [] });
});
it('keeps a session live until its last owned process exits and never treats completed unread output as running', () => {
  process(20, null, 'session-a');
  process(21, null, 'session-a');
  expect(backgroundExecObligations('session-a').running).toEqual([20, 21]);
  processes.set(20, 0);
  expect(backgroundExecObligations('session-a')).toMatchObject({ running: [21], exitedUnread: [{ processId: 20, exitCode: 0 }] });
  processes.set(21, 3);
  expect(backgroundExecObligations('session-a')).toMatchObject({ running: [], exitedUnread: [
    { processId: 20, exitCode: 0 }, { processId: 21, exitCode: 3 }
  ] });
});
it('stops only a process owned by the requested durable session', async () => {
  process(10, null, 'session-a');
  process(11, null, 'session-b');
  await expect(stopExecProcess('session-a', 10, 510)).resolves.toBe(true);
  await expect(stopExecProcess('session-a', 11, 511)).resolves.toBe(false);
  expect(terminateProcess).toHaveBeenCalledTimes(1);
  expect(terminateProcess).toHaveBeenCalledWith(10, 510);
});
it('reoffers a failed response but suppresses pending and published reminders', () => {
  process();
  expect(notice()).toEqual([]);
  vi.advanceTimersByTime(UNATTENDED_EXEC_NOTICE_MS);
  const first = publication();
  const offered = notice(first);
  expect(offered).toEqual([expect.stringContaining('running unpolled')]);
  expect(notice()).toEqual([]);
  first.failed = true;
  const second = publication();
  expect(notice(second)).toEqual(offered);
  second.completedAt = Date.now();
  vi.advanceTimersByTime(100);
  expect(notice()).toEqual([]);
  noteExecAttended(10);
  expect(notice()).toEqual([]);
  vi.advanceTimersByTime(UNATTENDED_EXEC_NOTICE_MS);
  expect(notice()).toHaveLength(1);
});
it('bounds reminder batches and isolates owners, including numeric ID reuse', () => {
  for (let id = 10; id < 18; id++) process(id);
  vi.advanceTimersByTime(UNATTENDED_EXEC_NOTICE_MS);
  expect(notice(publication(), 'session-b')).toEqual([]);
  expect(notice()).toHaveLength(3);
  expect(notice()).toHaveLength(3);
  expect(notice()).toHaveLength(2);
  expect(notice()).toEqual([]);
  forgetExecOwner(10);
  process(10, null, 'session-b');
  vi.advanceTimersByTime(UNATTENDED_EXEC_NOTICE_MS);
  expect(notice()).toEqual([]);
  expect(notice(publication(), 'session-b')).toHaveLength(1);
});
