import { createHash } from 'node:crypto';

import type { JsonValue } from './discovery/models.js';

/**
 * Deterministic JSON serialization: object keys sort, so two structurally equal
 * values always hash the same regardless of construction order.
 */
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
