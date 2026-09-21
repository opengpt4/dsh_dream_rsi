import { createHash } from 'node:crypto';

import { redactSecrets } from '../governance/redaction.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append-only audit trail for approval, deployment, degradation, rollback, lock
 * recovery, emergency stop, and tool activation.
 *
 * Events are never rewritten or deleted: an audit record that can be edited is
 * not an audit record. `eventId` is a hash over the event body, and
 * {@link verifyAuditEvent} is how a reader checks a line against it — a
 * recorded event is frozen, so it cannot be edited through the reference
 * `record` hands back.
 */

export const AUDIT_SCHEMA_VERSION = 1;

/** What an event is about. `subjectId` is a deploymentId, sessionId, or toolId. */
export type AuditSubject = 'deployment' | 'session' | 'tool';

export type AuditEventType =
  | 'policy.proposed'
  | 'policy.approved'
  | 'policy.rejected'
  | 'canary.started'
  | 'canary.failed'
  | 'policy.deployed'
  | 'policy.degraded'
  | 'policy.rolled-back'
  | 'lock.recovered'
  | 'action.emergency-stop'
  | 'tool.enabled'
  | 'tool.disabled'
  | 'tool.rolled-back';

export interface AuditEvent {
  readonly eventId: string;
  readonly type: AuditEventType;
  readonly subject: AuditSubject;
  readonly subjectId: string;
  readonly correlationId: string;
  readonly policyArtifactId?: string;
  readonly operator?: string;
  readonly reason?: string;
  readonly lockOwner?: string;
  readonly at: string;
  readonly schemaVersion: number;
}

export type AuditEventInput = Omit<AuditEvent, 'eventId' | 'schemaVersion'> & { readonly schemaVersion?: number };

export interface AuditSink {
  record(event: AuditEventInput): AuditEvent;
}

/** Every field an event body may carry, `eventId` aside. */
const AUDIT_BODY_FIELDS = new Set<string>([
  'schemaVersion',
  'type',
  'subject',
  'subjectId',
  'correlationId',
  'at',
  'policyArtifactId',
  'operator',
  'reason',
  'lockOwner'
]);

/**
 * The hashed body of an event, rebuilt field by field.
 *
 * One definition for both the writer and {@link verifyAuditEvent}, so a field
 * cannot be covered when the event is written and ignored when it is checked.
 */
export function auditEventBody(event: Omit<AuditEvent, 'eventId'>): Omit<AuditEvent, 'eventId'> {
  return {
    schemaVersion: event.schemaVersion,
    type: event.type,
    subject: event.subject,
    subjectId: event.subjectId,
    correlationId: event.correlationId,
    at: event.at,
    ...(event.policyArtifactId !== undefined ? { policyArtifactId: event.policyArtifactId } : {}),
    ...(event.operator !== undefined ? { operator: event.operator } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.lockOwner !== undefined ? { lockOwner: event.lockOwner } : {})
  };
}

function hashAuditBody(body: Omit<AuditEvent, 'eventId'>): string {
  return createHash('sha256').update(JSON.stringify(auditEventBody(body))).digest('hex');
}

/**
 * Whether an event is the one that was written.
 *
 * Strict: an unrecognised field counts as an alteration, because a reader that
 * ignored it would report an edited line as intact.
 */
export function verifyAuditEvent(event: AuditEvent): boolean {
  for (const key of Object.keys(event)) {
    if (key !== 'eventId' && !AUDIT_BODY_FIELDS.has(key)) return false;
  }
  const { eventId, ...body } = event;
  return eventId === hashAuditBody(body);
}

export function createAuditEvent(input: AuditEventInput): AuditEvent {
  // An operator pasting a token into a free-text reason must not put it in the
  // permanent trail. Redaction happens before hashing, so the id covers what is
  // actually stored.
  const reason = input.reason === undefined ? undefined : redactSecrets(input.reason).text;
  const body = auditEventBody({
    schemaVersion: AUDIT_SCHEMA_VERSION,
    type: input.type,
    subject: input.subject,
    subjectId: input.subjectId,
    correlationId: input.correlationId,
    at: input.at,
    ...(input.policyArtifactId !== undefined ? { policyArtifactId: input.policyArtifactId } : {}),
    ...(input.operator !== undefined ? { operator: input.operator } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(input.lockOwner !== undefined ? { lockOwner: input.lockOwner } : {})
  });
  // Frozen because the trail must not be editable by the caller that recorded
  // it: `record` hands back the same object the log keeps, and a shallow freeze
  // is total here since every field is a primitive.
  return Object.freeze({ eventId: hashAuditBody(body), ...body });
}

export class InMemoryAuditLog implements AuditSink {
  private readonly events: AuditEvent[] = [];

  record(event: AuditEventInput): AuditEvent {
    const created = createAuditEvent(event);
    this.events.push(created);
    return created;
  }

  list(): readonly AuditEvent[] {
    return [...this.events];
  }

  types(): readonly AuditEventType[] {
    return this.events.map((event) => event.type);
  }
}

/** One JSON object per line, appended. A partial final line is the reader's problem, not a rewrite. */
export class FileAuditLog implements AuditSink {
  constructor(private readonly filePath: string) {}

  record(event: AuditEventInput): AuditEvent {
    const created = createAuditEvent(event);
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(created)}\n`);
    return created;
  }

  /**
   * Read the trail back, checking every line against its `eventId`.
   *
   * Fails closed on the first line that does not match, and on a final line
   * that is not complete JSON: the append is not atomic, so an interrupted
   * write is exactly the line a reader must not accept as an event.
   */
  read(): readonly AuditEvent[] {
    if (!existsSync(this.filePath)) return [];
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    // The writer terminates every line, so the split leaves one empty tail.
    if (lines[lines.length - 1] === '') lines.pop();

    const events: AuditEvent[] = [];
    for (const [index, line] of lines.entries()) {
      let event: AuditEvent;
      try {
        event = JSON.parse(line) as AuditEvent;
      } catch {
        throw new Error(`audit log line ${index + 1} is not a complete event`);
      }
      if (!verifyAuditEvent(event)) {
        throw new Error(`audit log line ${index + 1} does not match its event id`);
      }
      events.push(event);
    }
    return Object.freeze(events);
  }
}
