/**
 * The only route to a model, as seen by evolution code.
 *
 * Nothing here exposes a provider SDK, credentials, or a transport: an adapter
 * supplies `invoke` and the harness owns everything else. Candidate generation
 * receives this interface and nothing wider, so it cannot reach a host secret
 * even by mistake.
 */

export interface LlmRequest {
  readonly model: string;
  readonly prompt: string;
  /** System instruction, kept separate so it is never confused with candidate data. */
  readonly system?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly correlationId: string;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly usage: LlmUsage;
  readonly finishReason: 'stop' | 'length' | 'error';
}

export interface HarnessLlm {
  invoke(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

/**
 * Mutation classes an evolved policy may change.
 *
 * The frozen model, evaluation data, deployment registry, and secrets are not
 * on this list and cannot be added to it by a candidate: a proposal naming
 * anything else is rejected before its source is scanned.
 */
export const MUTATION_CLASSES = ['scheduling', 'pruning', 'retry', 'parallelism', 'budget'] as const;

export type MutationClass = (typeof MUTATION_CLASSES)[number];

export function assertMutationClassesAllowed(classes: readonly string[]): readonly MutationClass[] {
  if (classes.length === 0) throw new Error('a candidate must declare at least one mutation class');
  const unknown = classes.filter((candidate) => !(MUTATION_CLASSES as readonly string[]).includes(candidate));
  if (unknown.length > 0) {
    throw new Error(
      `mutation class(es) not permitted: ${unknown.join(', ')}; permitted classes are ${MUTATION_CLASSES.join(', ')}`
    );
  }
  return [...new Set(classes)] as readonly MutationClass[];
}
