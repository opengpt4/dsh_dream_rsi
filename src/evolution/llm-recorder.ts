import { createHash } from 'node:crypto';

import type { MetricsSink } from '../observability/metrics.js';
import type { HarnessLlm, LlmRequest, LlmResponse } from './harness.js';

/**
 * Records what every model call cost.
 *
 * The design requires the adapter to record request and response hashes, token
 * usage, latency, retry count, provider error class, and correlation id. Hashes
 * rather than bodies: the prompt can hold candidate and observation text, and a
 * record that keeps it turns an observability log into a second copy of the
 * data it is meant to describe.
 */

export const LLM_RECORD_SCHEMA_VERSION = 1;

export interface LlmCallRecord {
  readonly correlationId: string;
  readonly model: string;
  readonly requestHash: string;
  /** Absent when the call never produced a response. */
  readonly responseHash: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  /** 1 means it succeeded first try. */
  readonly attempts: number;
  /** Provider error class or message class, `null` on success. */
  readonly errorClass: string | null;
  readonly at: string;
}

export interface LlmRecorderOptions {
  /** Attempts per call, including the first. Defaults to 1: no retry. */
  readonly maxAttempts?: number;
  readonly metrics?: MetricsSink;
  /** Labels attached to every emitted sample. */
  readonly labels?: { readonly taskId?: string; readonly episodeId?: string; readonly model?: string };
  readonly now?: () => number;
}

export interface RecordingLlm extends HarnessLlm {
  records(): readonly LlmCallRecord[];
  totals(): { readonly inputTokens: number; readonly outputTokens: number; readonly calls: number };
}

export class LlmRecordingError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly errorClass: string,
    readonly record: LlmCallRecord
  ) {
    super(message);
    this.name = 'LlmRecordingError';
  }
}

/**
 * Wrap a harness LLM so every call is recorded.
 *
 * Retries are bounded and counted. `maxAttempts: 1` means a failure is reported
 * once rather than silently retried, because a provider that is down should
 * surface as a failure rather than as latency.
 */
export function createRecordingLlm(llm: HarnessLlm, options: LlmRecorderOptions = {}): RecordingLlm {
  const maxAttempts = options.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  const now = options.now ?? Date.now;
  const records: LlmCallRecord[] = [];

  const classify = (error: unknown): string => {
    if (error !== null && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code);
    if (error instanceof Error) return error.name;
    return 'unknown';
  };

  return {
    async invoke(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      const requestHash = hashish({ model: request.model, prompt: request.prompt, system: request.system ?? null });
      let attempts = 0;
      let lastError: unknown;
      const startedAt = now();

      while (attempts < maxAttempts) {
        attempts += 1;
        try {
          const response = await llm.invoke(request, signal);
          const latencyMs = now() - startedAt;
          const record: LlmCallRecord = {
            correlationId: request.correlationId,
            model: response.model,
            requestHash,
            responseHash: hashish({ text: response.text, finishReason: response.finishReason }),
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            latencyMs,
            attempts,
            errorClass: null,
            at: new Date().toISOString()
          };
          records.push(record);
          emit(options, record);
          return response;
        } catch (error) {
          lastError = error;
        }
      }

      const errorClass = classify(lastError);
      const record: LlmCallRecord = {
        correlationId: request.correlationId,
        model: request.model,
        requestHash,
        responseHash: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: now() - startedAt,
        attempts,
        errorClass,
        at: new Date().toISOString()
      };
      records.push(record);
      emit(options, record);
      throw new LlmRecordingError(
        `llm call failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        attempts,
        errorClass,
        record
      );
    },

    records(): readonly LlmCallRecord[] {
      return records.map((record) => ({ ...record }));
    },

    totals() {
      return {
        inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
        outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
        calls: records.length
      };
    }
  };
}

function emit(options: LlmRecorderOptions, record: LlmCallRecord): void {
  const metrics = options.metrics;
  if (metrics === undefined) return;
  const labels = { ...options.labels, correlationId: record.correlationId, model: record.model };

  metrics.record('llm.inputTokens', record.inputTokens, labels);
  metrics.record('llm.outputTokens', record.outputTokens, labels);
  metrics.record('llm.latencyMs', record.latencyMs, labels);
  if (record.attempts > 1) metrics.record('llm.retry', record.attempts - 1, labels);
  if (record.errorClass !== null) metrics.record('llm.failure', 1, { ...labels, outcome: record.errorClass });
}

function hashish(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
