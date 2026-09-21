import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createHash } from 'node:crypto';

/**
 * Append-only audit trail for approval, deployment, degradation, rollback, and
 * lock recovery.
 *
 * Events are never rewritten or deleted: an audit record that can be edited is
 * not an audit record. `eventId` is the hash of the event body, so a reader can
 * tell whether a line was altered.
 */

export const AUDIT_SCHEMA_VERSION = 1;

export type AuditEventType =
  | 'policy.proposed'
  | 'policy.approved'
  | 'policy.rejected'
  | 'canary.started'
  | 'canary.failed'
  | 'policy.deployed'
  | 'policy.degraded'
  | 'policy.rolled-back'
  | 'lock.recovered';

export interface AuditEvent {
  readonly eventId: string;
  readonly type: AuditEventType;
  readonly deploymentId: string;
  readonly policyArtifactId: string;
  readonly correlationId: string;
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

export function createAuditEvent(input: AuditEventInput): AuditEvent {
  const body = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    type: input.type,
    deploymentId: input.deploymentId,
    policyArtifactId: input.policyArtifactId,
    correlationId: input.correlationId,
    at: input.at,
    ...(input.operator !== undefined ? { operator: input.operator } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.lockOwner !== undefined ? { lockOwner: input.lockOwner } : {})
  };
  return { eventId: createHash('sha256').update(JSON.stringify(body)).digest('hex'), ...body };
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
}
