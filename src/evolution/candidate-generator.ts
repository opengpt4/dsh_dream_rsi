import { createHash } from 'node:crypto';

import { hashJson } from '../hash.js';
import { scanCandidate, type CandidateGateResult } from '../guardrails/candidate-gate.js';
import {
  createPolicyArtifact,
  type EvaluationMetrics,
  type EvaluationReport,
  type PolicyArtifact,
  type PolicyManifest
} from '../registry/models.js';
import type { PolicyRegistry } from '../registry/policy-registry.js';
import { assertMutationClassesAllowed, MUTATION_CLASSES, type HarnessLlm, type MutationClass } from './harness.js';

/**
 * Evaluate-only candidate generation.
 *
 * A proposal is generated, scanned, and evaluated. It is never promoted: this
 * module has no path to the current-policy pointer, and evaluating a candidate
 * leaves the pointer where it was.
 */

export const CANDIDATE_SCHEMA_VERSION = 1;

export interface GenerateCandidateInput {
  readonly parent: PolicyArtifact;
  readonly parentSource: string;
  /** Train and validation metrics only. Holdout is never an input. */
  readonly trainMetrics: EvaluationMetrics;
  readonly validationMetrics: EvaluationMetrics;
  readonly seed: string;
  readonly model: string;
  readonly correlationId: string;
  readonly maxOutputTokens?: number;
}

export interface CandidateProposal {
  /** Reproducible: a function of the parent version, source, manifest, and seed. */
  readonly buildId: string;
  readonly parentVersion: string | null;
  readonly mutationClasses: readonly MutationClass[];
  readonly rationale: string;
  readonly source: string;
  readonly manifest: PolicyManifest;
  readonly seed: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface GenerateCandidateOptions {
  readonly entrypoint?: string;
  readonly signal?: AbortSignal;
}

export async function generateCandidate(
  llm: HarnessLlm,
  input: GenerateCandidateInput,
  options: GenerateCandidateOptions = {}
): Promise<CandidateProposal> {
  const response = await llm.invoke(
    {
      model: input.model,
      system: SYSTEM_INSTRUCTION,
      prompt: buildPrompt(input),
      correlationId: input.correlationId,
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {})
    },
    options.signal
  );

  return parseCandidateProposal(response.text, {
    parent: input.parent,
    seed: input.seed,
    usage: response.usage,
    ...(options.entrypoint !== undefined ? { entrypoint: options.entrypoint } : {})
  });
}

const SYSTEM_INSTRUCTION = [
  'You evolve the orchestration policy of a coding agent. The model is frozen.',
  `You may change only these mutation classes: ${MUTATION_CLASSES.join(', ')}.`,
  'You may not alter model weights, evaluation data, the deployment registry, or secrets.',
  'Respond with one JSON object and nothing else, with fields:',
  '  mutationClasses: array of the permitted class names you changed;',
  '  rationale: one short paragraph;',
  '  source: the complete replacement policy source as a string;',
  '  dependencies: optional array of package names the source imports.'
].join('\n');

/**
 * Project the generation input into a prompt.
 *
 * Built from named fields rather than by serializing the input, so a caller
 * that attaches holdout results or deployment state cannot leak them into the
 * prompt by doing so.
 */
export function buildPrompt(input: GenerateCandidateInput): string {
  return [
    `seed: ${input.seed}`,
    `parent version: ${input.parent.version}`,
    `parent allowed capabilities: ${input.parent.allowedCapabilities.join(', ')}`,
    '',
    'parent source:',
    input.parentSource,
    '',
    `train metrics: ${JSON.stringify(input.trainMetrics)}`,
    `validation metrics: ${JSON.stringify(input.validationMetrics)}`
  ].join('\n');
}

export interface ParseCandidateContext {
  readonly parent: PolicyArtifact;
  readonly seed: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly entrypoint?: string;
}

/**
 * Parse a model reply into a proposal.
 *
 * Strict: a missing or mistyped field is rejected rather than defaulted, and a
 * mutation class outside the permitted set is rejected here, before the source
 * reaches any other guard.
 */
export function parseCandidateProposal(text: string, context: ParseCandidateContext): CandidateProposal {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('candidate reply contains no JSON object');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`candidate reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('candidate reply is not a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.mutationClasses)) throw new Error('candidate reply has no mutationClasses array');
  if (typeof record.rationale !== 'string' || record.rationale.trim().length === 0) {
    throw new Error('candidate reply has no rationale');
  }
  if (typeof record.source !== 'string' || record.source.trim().length === 0) {
    throw new Error('candidate reply has no source');
  }
  if (record.dependencies !== undefined && !isStringArray(record.dependencies)) {
    throw new Error('candidate dependencies must be an array of strings');
  }

  const mutationClasses = assertMutationClassesAllowed(record.mutationClasses as string[]);
  const manifest: PolicyManifest = {
    entrypoint: context.entrypoint ?? 'src/policy.ts',
    dependencies: (record.dependencies as string[] | undefined) ?? [],
    schemaVersion: CANDIDATE_SCHEMA_VERSION
  };
  const sourceSha256 = createHash('sha256').update(record.source).digest('hex');

  return {
    buildId: buildIdentifier({
      parentVersion: context.parent.version,
      sourceSha256,
      manifest,
      seed: context.seed
    }),
    parentVersion: context.parent.version,
    mutationClasses,
    rationale: record.rationale,
    source: record.source,
    manifest,
    seed: context.seed,
    usage: context.usage
  };
}

export interface BuildIdentifierInput {
  readonly parentVersion: string | null;
  readonly sourceSha256: string;
  readonly manifest: PolicyManifest;
  readonly seed: string;
}

/** Reproducible build identifier: a pure function of the candidate's identity. */
export function buildIdentifier(input: BuildIdentifierInput): string {
  return hashJson({
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    parentVersion: input.parentVersion,
    sourceSha256: input.sourceSha256,
    seed: input.seed,
    manifest: {
      entrypoint: input.manifest.entrypoint,
      dependencies: [...input.manifest.dependencies],
      schemaVersion: input.manifest.schemaVersion
    }
  });
}

export interface CandidateEvaluationInput {
  readonly llm: HarnessLlm;
  readonly generation: GenerateCandidateInput;
  readonly registry: PolicyRegistry;
  readonly candidateRoot?: string;
  readonly allowedPackages?: readonly string[];
  readonly allowedBuiltins?: readonly string[];
  readonly entrypoint?: string;
  /** Runs one evaluation of the generated source and returns its report. */
  readonly evaluate: (artifact: PolicyArtifact) => Promise<EvaluationReport>;
  readonly signal?: AbortSignal;
}

export interface CandidateEvaluationResult {
  readonly proposal: CandidateProposal;
  readonly artifact: PolicyArtifact;
  readonly gate: CandidateGateResult;
  readonly report: EvaluationReport;
  /** Always `false`. Generation evaluates; it never promotes. */
  readonly promoted: false;
}

/**
 * Generate, scan, register, and evaluate one candidate.
 *
 * The guard runs before the artifact is registered and before any evaluation
 * work, so a rejected candidate registers nothing and costs no episode. The
 * current-policy pointer is never touched.
 */
export async function evaluateCandidate(input: CandidateEvaluationInput): Promise<CandidateEvaluationResult> {
  const proposal = await generateCandidate(input.llm, input.generation, {
    ...(input.entrypoint !== undefined ? { entrypoint: input.entrypoint } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {})
  });

  const gate = scanCandidate({
    source: proposal.source,
    fileName: proposal.manifest.entrypoint,
    ...(input.candidateRoot !== undefined ? { candidateRoot: input.candidateRoot } : {}),
    ...(input.allowedPackages !== undefined ? { allowedPackages: input.allowedPackages } : {}),
    ...(input.allowedBuiltins !== undefined ? { allowedBuiltins: input.allowedBuiltins } : {})
  });
  if (!gate.passed) {
    const rules = [
      ...gate.ast.violations.map((violation) => violation.rule),
      ...gate.imports.violations.map((violation) => violation.rule)
    ];
    throw new Error(`candidate ${proposal.buildId} rejected by ${rules.length} guard rule(s): ${rules.join(', ')}`);
  }

  const artifact = createPolicyArtifact({
    // `parent+build` is deterministic and shows lineage at a glance.
    version: `${input.generation.parent.version}+${proposal.buildId.slice(0, 8)}`,
    parentVersion: input.generation.parent.version,
    source: proposal.source,
    manifest: proposal.manifest,
    allowedCapabilities: proposal.mutationClasses,
    createdBy: 'evolution-agent'
  });
  input.registry.registerPolicy(artifact);

  const report = await input.evaluate(artifact);
  return { proposal, artifact, gate, report, promoted: false };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
