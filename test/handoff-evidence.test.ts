import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallRecord } from '../src/shared/session.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));

const { initConfigPath, saveConfig, defaultConfig } = await import('../src/main/config.js');
const { buildHandoffEvidence, MAX_HANDOFF_EVIDENCE_CHARS } = await import('../src/main/session/handoff-evidence.js');
const { createSession, appendEvent, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
const CHAT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeAll(async () => {
  dir = await makeTempDir('clf-handoff-evidence-');
  initConfigPath(dir);
  initSessionStore(dir);
  await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
});

afterAll(async () => {
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  await resetSessionStoreForTests();
});

function call(callId: string, tool: string, result: string, options: { outcome?: 'ok' | 'process_exit_nonzero'; requestId?: string; changes?: any[] } = {}): ToolCallRecord {
  const failed = options.outcome === 'process_exit_nonzero';
  return {
    callId,
    tool,
    attribution: 'request_id' as const,
    requestId: options.requestId ?? `req-${callId}`,
    conversationId: CHAT,
    attributionMethod: 'request_id' as const,
    args: { text: JSON.stringify({ command: tool === 'exec_command' ? `run-${callId}` : callId }), truncated: false, chars: 30 },
    result: { text: result, truncated: false, chars: result.length },
    outcome: options.outcome ?? 'ok' as const,
    durationMs: 25,
    summary: { title: `Did ${tool}`, metric: failed ? '✕ exit 1' : '✓ done', tone: failed ? 'bad' : 'good', kind: 'run' },
    ...(options.changes ? { changes: options.changes } : {})
  };
}

async function sourceSession() {
  const session = await createSession({ title: 'evidence', conversationId: CHAT });
  await appendEvent(session.id, { time: 10, source: 'extension', kind: 'user_message', message: { text: 'fix the handoff', truncated: false, chars: 15 }, messageId: 'question' });
  await appendEvent(session.id, { time: 20, source: 'extension', kind: 'turn_start', turnId: 'turn-a' });
  return session;
}

describe('handoff execution evidence', () => {
  it('selects only exact source-turn/request-attributed work and keeps logical order', async () => {
    const session = await sourceSession();
    await appendEvent(session.id, { time: 40, source: 'extension', kind: 'progress', turnId: 'turn-a', message: { text: 'running checks', truncated: false, chars: 14 }, progressId: 'p1' });
    // Appended after the progress row but logically started first: chronology should put it first.
    await appendEvent(session.id, { time: 30, source: 'mcp', kind: 'tool_call', turnId: 'turn-a', call: call('one', 'exec_command', 'tests passed') });
    await appendEvent(session.id, { time: 50, source: 'mcp', kind: 'tool_call', turnId: 'turn-other', call: call('foreign-turn', 'exec_command', 'must not appear') });
    await appendEvent(session.id, { time: 60, source: 'mcp', kind: 'tool_call', turnId: 'turn-a', call: { ...call('foreign-chat', 'exec_command', 'must not appear'), conversationId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' } });
    await appendEvent(session.id, { time: 70, source: 'extension', kind: 'turn_end', turnId: 'turn-a', outcome: 'stopped' });

    const evidence = await buildHandoffEvidence({ sessionId: session.id, sourceConversationId: CHAT, sourceTurnId: 'turn-a', includeToolDetails: true });
    expect(evidence.text).toContain('SOURCE USER MESSAGE');
    expect(evidence.text).toContain('fix the handoff');
    expect(evidence.text).toContain('tests passed');
    expect(evidence.text).toContain('running checks');
    expect(evidence.text.indexOf('TOOL exec_command')).toBeLessThan(evidence.text.indexOf('running checks'));
    expect(evidence.text).not.toContain('must not appear');
    expect(evidence.sourceTurnId).toBe('turn-a');
    expect(evidence.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps action and outcome while the tool-detail setting removes raw bodies', async () => {
    const session = await sourceSession();
    await appendEvent(session.id, { time: 30, source: 'mcp', kind: 'tool_call', turnId: 'turn-a', call: call('failed', 'exec_command', 'very specific raw stderr', { outcome: 'process_exit_nonzero' }) });

    const summary = await buildHandoffEvidence({ sessionId: session.id, sourceConversationId: CHAT, sourceTurnId: 'turn-a', includeToolDetails: false });
    const detailed = await buildHandoffEvidence({ sessionId: session.id, sourceConversationId: CHAT, sourceTurnId: 'turn-a', includeToolDetails: true });
    expect(summary.text).toContain('TOOL exec_command — process_exit_nonzero');
    expect(summary.text).not.toContain('very specific raw stderr');
    expect(summary.text).not.toContain('Arguments:');
    expect(detailed.text).toContain('very specific raw stderr');
    expect(detailed.text).toContain('Arguments:');
  });

  it('retains newest actions and an explicit omission marker inside its bound', async () => {
    const session = await sourceSession();
    for (let index = 0; index < 40; index++) {
      await appendEvent(session.id, {
        time: 30 + index,
        source: 'mcp',
        kind: 'tool_call',
        turnId: 'turn-a',
        call: call(`call-${index}`, 'exec_command', `result-${index}-${'x'.repeat(400)}`)
      });
    }
    const evidence = await buildHandoffEvidence({
      sessionId: session.id, sourceConversationId: CHAT, sourceTurnId: 'turn-a', includeToolDetails: true, maxChars: 6_000
    });
    expect(evidence.text.length).toBeLessThanOrEqual(6_000);
    expect(evidence.text).toContain('newest actions retained');
    expect(evidence.text).toContain('result-39-');
    expect(evidence.text).not.toContain('result-0-');
  });

  it('uses a bounded recent session tail when no source turn identity exists', async () => {
    const session = await sourceSession();
    await appendEvent(session.id, { time: 30, source: 'mcp', kind: 'tool_call', call: call('tail', 'exec_command', 'tail result') });
    const evidence = await buildHandoffEvidence({ sessionId: session.id, sourceConversationId: CHAT, sourceTurnId: null, includeToolDetails: false });
    expect(evidence.text).toContain('unavailable; bounded recent session tail used');
    expect(evidence.text).not.toContain('tail result');
    expect(evidence.text).toContain('TOOL exec_command — ok');
    expect(evidence.text.length).toBeLessThanOrEqual(MAX_HANDOFF_EVIDENCE_CHARS);
  });
});
