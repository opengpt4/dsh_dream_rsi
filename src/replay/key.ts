import { createHash } from 'node:crypto';

import type { JsonValue } from '../discovery/models.js';

export const REPLAY_KEY_SCHEMA_VERSION = 1;

export interface ReplayKeyInput {
  readonly environmentVersion: string;
  readonly stateHash: string;
  readonly actionType: string;
  readonly normalizedActionParams: JsonValue;
  readonly observationHash: string;
}

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function createReplayKey(input: ReplayKeyInput): string {
  return hashJson({
    schemaVersion: REPLAY_KEY_SCHEMA_VERSION,
    environmentVersion: input.environmentVersion,
    stateHash: input.stateHash,
    actionType: input.actionType,
    normalizedActionParams: input.normalizedActionParams,
    observationHash: input.observationHash
  });
}
