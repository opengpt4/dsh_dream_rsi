import type { JsonValue } from '../discovery/models.js';

/**
 * Secret redaction for text that leaves the trust boundary.
 *
 * Redaction belongs where data is emitted for operators — audit reasons, log
 * lines, reports — and not in recorded ground truth. A discovery node must
 * record what the environment actually returned, or replay stops reproducing
 * it.
 */

export interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Defaults to `[redacted]` when absent. */
  readonly replacement?: string;
}

export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: 'authorization-header',
    pattern: /(["']?authorization["']?\s*:\s*["'])([^"']+)(["'])/gi,
    replacement: '$1[redacted]$3'
  },
  {
    name: 'credential-assignment',
    // A variable whose name says it holds a credential, whatever the value is.
    pattern: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY)[A-Za-z0-9_]*\s*[=:]\s*)(\S+)/gi,
    replacement: '$1[redacted]'
  },
  {
    name: 'url-credentials',
    pattern: /:\/\/[^:@\s/]+:[^@\s/]+@/g,
    replacement: '://[redacted]@'
  }
];

export interface Redaction {
  readonly rule: string;
  readonly count: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly redacted: boolean;
  readonly redactions: readonly Redaction[];
}

export function redactSecrets(text: string, rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES): RedactionResult {
  let output = text;
  const redactions: Redaction[] = [];

  for (const rule of rules) {
    // Rules carry the `g` flag and are reused across calls, so lastIndex must
    // be reset or alternating calls would skip matches.
    rule.pattern.lastIndex = 0;
    const matches = output.match(rule.pattern);
    if (matches === null || matches.length === 0) continue;
    rule.pattern.lastIndex = 0;
    output = output.replace(rule.pattern, rule.replacement ?? '[redacted]');
    redactions.push({ rule: rule.name, count: matches.length });
  }

  return { text: output, redacted: redactions.length > 0, redactions };
}

/** Apply redaction through a JSON structure, preserving shape. */
export function redactValue(
  value: JsonValue,
  rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES
): { readonly value: JsonValue; readonly redacted: boolean } {
  let redacted = false;
  const walk = (input: JsonValue): JsonValue => {
    if (typeof input === 'string') {
      const result = redactSecrets(input, rules);
      if (result.redacted) redacted = true;
      return result.text;
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, walk(entry)]));
    }
    return input;
  };
  const output = walk(value);
  return { value: output, redacted };
}
