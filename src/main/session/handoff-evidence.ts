/**
 * Deterministic recent-work evidence for Compact & Resume.
 *
 * The model-written brief remains responsible for intent, decisions and causal explanation.
 * This module owns a smaller, code-derived statement of what the local recorder can prove ran
 * immediately before the handoff boundary. It deliberately reads only persisted/redacted
 * session material; raw MCP payloads never get a second path into model context here.
 */

import { createHash } from 'node:crypto';
import type { HandoffEvidence, SessionEvent, SessionSummary, StoredText } from '../../shared/session.js';
import { normalizedToolOutcome, toolCallSummary } from '../../shared/session.js';
import { injectedUserMessage, positionOf, responseTurnId } from '../../shared/chronology.js';
import { getSession, readEvents, readRecentEvents } from './store.js';

export const MAX_HANDOFF_EVIDENCE_CHARS = 24_000;
const MAX_EVIDENCE_EVENTS = 1_024;
const MAX_QUESTION_CHARS = 1_600;
const MAX_MESSAGE_CHARS = 1_200;
const MAX_TOOL_ARGS_EVIDENCE_CHARS = 1_200;
const MAX_TOOL_RESULT_EVIDENCE_CHARS = 1_800;
const MAX_CHANGE_ROWS = 12;

export interface BuildHandoffEvidenceInput {
  sessionId: string;
  sourceConversationId: string;
  sourceTurnId: string | null;
  includeToolDetails: boolean;
  maxChars?: number;
}

export type HandoffEvidenceDraft = Omit<HandoffEvidence, 'id' | 'createdAt'>;

function clip(value: string, max: number): string {
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function stored(value: StoredText, max: number): string {
  return clip(value.text, max);
}

function indent(value: string): string {
  return value.split('\n').map(line => `    ${line}`).join('\n');
}

function hashEvidence(value: Omit<HandoffEvidenceDraft, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url');
}

function toolRow(event: Extract<SessionEvent, { kind: 'tool_call' }>, detailed: boolean): string {
  const call = event.call;
  const summary = toolCallSummary(call);
  const outcome = normalizedToolOutcome(call) ?? String(call.outcome);
  const lines = [`[${event.seq}] TOOL ${call.tool} — ${outcome}`];
  const summaryLine = [summary.title, summary.detail, summary.metric].filter(Boolean).join(' · ');
  if (summaryLine) lines.push(`  Summary: ${clip(summaryLine, 1_000)}`);
  if (call.requestId) lines.push(`  Request: ${clip(call.requestId, 180)}`);
  if (call.process?.sessionId) {
    const process = call.process;
    const state = process.completedAt
      ? `completed${process.exitCode === null || process.exitCode === undefined ? '' : `, exit ${process.exitCode}`}`
      : 'background process started';
    lines.push(`  Process: ${clip(process.sessionId, 180)} (${state})`);
  }
  if (call.changes?.length) {
    lines.push('  Changes:');
    for (const change of call.changes.slice(0, MAX_CHANGE_ROWS)) {
      lines.push(`    - ${clip(change.path, 500)} (+${change.added} -${change.removed})`);
    }
    if (call.changes.length > MAX_CHANGE_ROWS) lines.push(`    - … ${call.changes.length - MAX_CHANGE_ROWS} more changed files omitted`);
  }
  if (detailed) {
    const args = stored(call.args, MAX_TOOL_ARGS_EVIDENCE_CHARS);
    const result = stored(call.result, MAX_TOOL_RESULT_EVIDENCE_CHARS);
    if (args) lines.push(`  Arguments:\n${indent(args)}`);
    if (result) lines.push(`  Result:\n${indent(result)}`);
  }
  return lines.join('\n');
}

function eventRow(event: SessionEvent, detailed: boolean): string | null {
  switch (event.kind) {
    case 'tool_call':
      return toolRow(event, detailed);
    case 'assistant_message': {
      const text = stored(event.message, MAX_MESSAGE_CHARS);
      return text ? `[${event.seq}] ASSISTANT ${event.final ? 'FINAL' : 'PROGRESS'}\n${indent(text)}` : null;
    }
    case 'progress': {
      const text = stored(event.message, MAX_MESSAGE_CHARS);
      return text ? `[${event.seq}] ASSISTANT PROGRESS\n${indent(text)}` : null;
    }
    case 'page_tool':
      return `[${event.seq}] NATIVE TOOL — ${clip(event.label, 800)}`;
    case 'agent_message': {
      if (event.delivery !== 'delivered') return null;
      const text = stored(event.message, MAX_MESSAGE_CHARS);
      return text ? `[${event.seq}] AGENT MESSAGE ${event.from} → ${event.to}\n${indent(text)}` : null;
    }
    case 'turn_end':
      return `[${event.seq}] TURN END — ${event.outcome}${event.detail ? ` · ${clip(event.detail, 600)}` : ''}`;
    default:
      return null;
  }
}

function targetTurn(summary: SessionSummary, sourceTurnId: string | null): string | null {
  if (!sourceTurnId) return null;
  if (!summary.timelineTurns?.[sourceTurnId]) return null;
  return responseTurnId(summary.timelineTurns, sourceTurnId);
}

function sameTargetTurn(summary: SessionSummary, event: SessionEvent, target: string): boolean {
  return !!event.turnId && responseTurnId(summary.timelineTurns, event.turnId) === target;
}

function latestAuthoredQuestion(events: readonly SessionEvent[], summary: SessionSummary): Extract<SessionEvent, { kind: 'user_message' }> | null {
  let found: Extract<SessionEvent, { kind: 'user_message' }> | null = null;
  for (const event of events) {
    if (event.kind !== 'user_message' || event.automatic === true || injectedUserMessage(event, summary.timelineTurns)) continue;
    if (!found || positionOf(event) > positionOf(found)) found = event;
  }
  return found;
}

function boundEvidence(header: string, question: string | null, rows: readonly string[], maxChars: number): string {
  const prefix = [header, question].filter(Boolean).join('\n\n');
  const full = [prefix, ...rows].filter(Boolean).join('\n\n');
  if (full.length <= maxChars) return full;

  const chosen: string[] = [];
  let omitted = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    const marker = `[… ${index} earlier recorded action${index === 1 ? '' : 's'} omitted to fit the handoff evidence budget …]`;
    const candidate = [prefix, marker, rows[index], ...chosen].filter(Boolean).join('\n\n');
    if (candidate.length > maxChars) {
      omitted = index + 1;
      break;
    }
    chosen.unshift(rows[index]!);
  }
  const marker = omitted > 0
    ? `[… ${omitted} earlier recorded action${omitted === 1 ? '' : 's'} omitted to fit the handoff evidence budget; newest actions retained …]`
    : '';
  const bounded = [prefix, marker, ...chosen].filter(Boolean).join('\n\n');
  return bounded.length <= maxChars ? bounded : clip(bounded, maxChars);
}

/**
 * Builds the immutable, bounded text that will be persisted before the source handoff Send.
 * Throws when the continuation claims a source turn that the durable session cannot prove.
 */
export async function buildHandoffEvidence(input: BuildHandoffEvidenceInput): Promise<HandoffEvidenceDraft> {
  const summary = await getSession(input.sessionId);
  if (!summary) throw new Error('The source session no longer exists');
  if (summary.conversationId !== input.sourceConversationId) throw new Error('The source session is no longer attached to this conversation');

  const target = targetTurn(summary, input.sourceTurnId);
  if (input.sourceTurnId && !target) throw new Error('The source turn is not present in durable session history');

  const kinds: SessionEvent['kind'][] = [
    'user_message', 'assistant_message', 'progress', 'page_tool', 'tool_call', 'turn_start', 'turn_end', 'agent_message'
  ];
  const allQuestions = await readEvents(input.sessionId, { kinds: ['user_message'] });
  const questionId = target ? summary.timelineTurns?.[target]?.questionId : null;
  const question = questionId
    ? allQuestions.find((event): event is Extract<SessionEvent, { kind: 'user_message' }> =>
        event.kind === 'user_message' && event.messageId === questionId) ?? null
    : latestAuthoredQuestion(allQuestions, summary);
  const boundary = target
    ? summary.timelineTurns?.[target]?.origin ?? 0
    : question ? positionOf(question) : 0;
  const recent = await readRecentEvents(input.sessionId, MAX_EVIDENCE_EVENTS, {
    kinds,
    ...(boundary > 0 ? { after: Math.max(0, boundary - 1) } : {}),
    maxBytes: 4 * 1024 * 1024
  });

  const logicalCalls = new Map<string, Extract<SessionEvent, { kind: 'tool_call' }>>();
  const selected: SessionEvent[] = [];
  for (const event of recent) {
    if (event.kind === 'user_message' || event.kind === 'turn_start') continue;
    if (event.kind === 'tool_call') {
      const exactConversation = event.call.conversationId === input.sourceConversationId && event.call.attribution === 'request_id';
      const exactTurn = target ? sameTargetTurn(summary, event, target) : positionOf(event) >= boundary;
      if (!exactConversation || !exactTurn) continue;
      const held = logicalCalls.get(event.call.callId);
      if (!held || event.seq > held.seq) logicalCalls.set(event.call.callId, event);
      continue;
    }
    if (event.kind === 'agent_message') {
      if (event.delivery === 'delivered' && positionOf(event) >= boundary) selected.push(event);
      continue;
    }
    if (target ? sameTargetTurn(summary, event, target) : positionOf(event) >= boundary) selected.push(event);
  }
  selected.push(...logicalCalls.values());
  selected.sort((left, right) => {
    // readRecentEvents already projects turn-local chronology. Re-sort only by its stable
    // logical position/time tuple after merging canonical tool revisions back into that window.
    const lp = positionOf(left), rp = positionOf(right);
    if (left.turnId && right.turnId && responseTurnId(summary.timelineTurns, left.turnId) === responseTurnId(summary.timelineTurns, right.turnId)) {
      return left.time - right.time || lp - rp || left.seq - right.seq;
    }
    return lp - rp || left.seq - right.seq;
  });

  const questionText = question
    ? `SOURCE USER MESSAGE\n${indent(clip(question.authoredText ?? question.message.text, MAX_QUESTION_CHARS))}`
    : null;
  const rows = selected.map(event => eventRow(event, input.includeToolDetails)).filter((row): row is string => !!row);
  const sourceSeq = Math.max(0, question?.seq ?? 0, ...selected.map(event => event.seq));
  const header = [
    'DURABLE RECENT WORK — recorded by Chat On Steroids',
    'This is code-recorded execution evidence from the source session. It may contain work the interrupted source answer did not mention.',
    `Source conversation: ${input.sourceConversationId}`,
    `Source turn: ${target ?? input.sourceTurnId ?? 'unavailable; bounded recent session tail used'}`,
    `Tool detail mode: ${input.includeToolDetails ? 'detailed' : 'summary'}`
  ].join('\n');
  const text = boundEvidence(header, questionText, rows, Math.max(4_000, input.maxChars ?? MAX_HANDOFF_EVIDENCE_CHARS));
  const draftWithoutHash = {
    version: 1 as const,
    sessionId: input.sessionId,
    sourceConversationId: input.sourceConversationId,
    sourceTurnId: input.sourceTurnId,
    sourceSeq,
    detailMode: input.includeToolDetails ? 'detailed' as const : 'summary' as const,
    text
  };
  return { ...draftWithoutHash, hash: hashEvidence(draftWithoutHash) };
}

