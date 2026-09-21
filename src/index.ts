import { apply } from './adapter/cordis.js';

export { InMemoryDiscoveryStore, DISCOVERY_NODE_SCHEMA_VERSION, type DiscoveryNode, type DiscoveryStore, type JsonObject, type JsonValue } from './discovery/models.js';
export { SQLiteDiscoveryStore } from './discovery/sqlite-store.js';
export { canonicalJson, hashJson } from './hash.js';
export {
  createEvaluationReport,
  createPolicyArtifact,
  POLICY_ARTIFACT_SCHEMA_VERSION,
  summarizeCanary,
  summarizeCaseResults,
  verifyEvaluationReport,
  verifyPolicyArtifact,
  type Approval,
  type CanaryObservation,
  type CanaryResult,
  type CanaryThresholds,
  type CaseOutcome,
  type CaseResult,
  type CreatedBy,
  type Deployment,
  type DeploymentState,
  type EvaluationMetrics,
  type EvaluationReport,
  type FamilyRejectionSummary,
  type GuardResult,
  type PolicyArtifact,
  type PolicyManifest
} from './registry/models.js';
export {
  EMPTY_REGISTRY_SNAPSHOT,
  FilePolicyRegistryStore,
  InMemoryPolicyRegistryStore,
  PolicyRegistry,
  type PolicyPromotion,
  type PolicyRegistryStore,
  type RegistrySnapshot
} from './registry/policy-registry.js';
export {
  assertArtifactsVerified,
  ARTIFACT_KINDS,
  FileArtifactStore,
  type ArtifactKind,
  type ArtifactMetadata,
  type ArtifactStore,
  type ArtifactVerification,
  type ArtifactVerificationFailure,
  type PutArtifactInput
} from './artifacts/store.js';
export { createReplayKey, replayKeyInputFromNode, REPLAY_KEY_SCHEMA_VERSION } from './replay/key.js';
export { ReplaySimulator } from './replay/simulator.js';
export {
  MUTATION_CLASSES,
  assertMutationClassesAllowed,
  type HarnessLlm,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
  type MutationClass
} from './evolution/harness.js';
export {
  buildIdentifier,
  buildPrompt,
  evaluateCandidate,
  generateCandidate,
  parseCandidateProposal,
  CANDIDATE_SCHEMA_VERSION,
  type BuildIdentifierInput,
  type CandidateEvaluationInput,
  type CandidateEvaluationResult,
  type CandidateProposal,
  type GenerateCandidateInput,
  type GenerateCandidateOptions,
  type ParseCandidateContext
} from './evolution/candidate-generator.js';
export { evaluateReplay, DEFAULT_EVALUATOR_CONFIG } from './evolution/evaluator.js';
export { evaluateReplayIsolated, DEFAULT_MAX_OUTPUT_BYTES, type IsolatedEvaluatorOptions } from './evolution/isolated-evaluator.js';
export { splitDiscoveryNodes, DEFAULT_SPLIT_CONFIG } from './evolution/split.js';
export { evaluateMonotonicGate, DEFAULT_MONOTONIC_GATE_CONFIG } from './evolution/monotonic-gate.js';
export { createEvaluationSnapshot, type EvaluationSnapshot } from './evolution/snapshot.js';
export { SingleWriterLock } from './operations/single-writer-lock.js';
export { runAstGuard, type AstGuardResult, type AstGuardViolation } from './guardrails/ast-guard.js';
export {
  checkImports,
  type Capability,
  type ImportAllowlistOptions,
  type ImportAllowlistResult,
  type ImportKind,
  type ImportViolation
} from './guardrails/import-allowlist.js';
export {
  assertCandidateAccepted,
  scanCandidate,
  type CandidateGateOptions,
  type CandidateGateResult
} from './guardrails/candidate-gate.js';
export { getDreamRsiStatus, createStatusTool, type DreamRsiStatus } from './status.js';
export {
  DEFAULT_DREAM_RSI_CONFIG,
  hashDreamRsiConfig,
  resolveDreamRsiConfig,
  validateDreamRsiConfig,
  type DreamRsiConfig,
  type DreamRsiConfigInput
} from './config.js';

/**
 * Schema the Cordis loader reads from `Plugin.Runtime.Config` to validate and
 * normalize each fiber's `config` before `apply` runs.
 */
export { DreamRsiConfigSchema as Config } from './config.js';

export {
  createDreamRsiRuntime,
  type DreamRsiHooks,
  type DreamRsiRuntime,
  type EvaluationSettings,
  type ReplaySettings
} from './runtime.js';

export {
  checkCapability,
  MOCK_CAPABILITY_PROFILE,
  type ActionCapability,
  type ActionLimits,
  type CapabilityCheck,
  type CapabilityProfile,
  type CapabilityQuery,
  type CapabilityRejection,
  type RejectionCode,
  type RiskLevel
} from './safety/capability.js';
export { canTransition, terminalStateFor, transition, type ActionState } from './safety/action-state.js';
export {
  ActionGuard,
  RATE_WINDOW_MS,
  type ActionGuardOptions,
  type ActionRecord,
  type ConfirmationRequest,
  type GuardedActionRequest
} from './safety/action-guard.js';

export {
  EMBODIED_ACTION_TYPES,
  OBSERVATION_SCHEMA_VERSION,
  type ActionRequest,
  type ActionResult,
  type ActionStatus,
  type EnvironmentAdapter,
  type GripperState,
  type Observation,
  type ObserveRequest,
  type Pose
} from './embodied/protocol.js';
export { MockEmbodiedBackend, type MockActionResult, type MockObservation, type MockObject } from './embodied/backend.js';
export { MockEnvironmentAdapter, MOCK_ENVIRONMENT_ID, MOCK_ENVIRONMENT_VERSION, MOCK_FRAME_ID } from './embodied/mock-adapter.js';
export { hashEnvironmentState, hashObservation } from './embodied/hash.js';
export {
  validateTask,
  type Episode,
  type EpisodeStatus,
  type ResourceBudget,
  type Task
} from './tasks/models.js';
export {
  planPolicy,
  runEpisode,
  type EpisodeOutcome,
  type Policy,
  type PolicyAction,
  type PolicyDecisionContext,
  type RunEpisodeOptions
} from './tasks/runner.js';
export {
  createIsolatedEvaluation,
  pipelineSettings,
  replayNodes,
  runEpisodePipeline,
  DEFAULT_EPISODE_PIPELINE_SETTINGS,
  type BoundaryMiss,
  type EpisodeGates,
  type EpisodePipelineOptions,
  type EpisodePipelineResult,
  type EpisodePipelineSettings,
  type EpisodeReplay,
  type ReplayReport
} from './tasks/pipeline.js';

export const name = 'dream-rsi';
export const inject: string[] = [];

/**
 * Cordis entrypoint for the Dream-RSI plugin. All Cordis-specific wiring
 * lives in `adapter/cordis.ts` so the rest of the package stays testable
 * without a Cordis context.
 */
export { apply };

