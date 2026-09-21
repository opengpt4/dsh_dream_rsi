import { apply } from './adapter/cordis.js';

export { InMemoryDiscoveryStore, DISCOVERY_NODE_SCHEMA_VERSION, type DiscoveryNode, type DiscoveryStore, type JsonObject, type JsonValue } from './discovery/models.js';
export { SQLiteDiscoveryStore } from './discovery/sqlite-store.js';
export { canonicalJson, hashJson } from './hash.js';
export {
  DEFAULT_REDACTION_RULES,
  redactSecrets,
  redactValue,
  type Redaction,
  type RedactionResult,
  type RedactionRule
} from './governance/redaction.js';
export {
  assertAccess,
  checkAccess,
  DEFAULT_ACCESS_POLICY,
  GOVERNED_ACTIONS,
  type AccessDecision,
  type AccessPolicy,
  type GovernedAction,
  type Principal,
  type Role
} from './governance/access-control.js';
export {
  DEFAULT_RETENTION_POLICY,
  expiredArtifacts,
  putWithRetention,
  retentionFor,
  validateRetentionPolicy,
  type RetentionPolicy
} from './governance/retention.js';
export {
  InMemoryMetrics,
  type MetricLabels,
  type MetricName,
  type MetricSample,
  type MetricSummary,
  type MetricsReader,
  type MetricsSink
} from './observability/metrics.js';
export {
  aggregate,
  rate,
  tCritical95,
  EMPTY_AGGREGATE,
  type Aggregate
} from './observability/statistics.js';
export {
  buildObservabilityReport,
  OBSERVABILITY_REPORT_SCHEMA_VERSION,
  type BuildReportInput,
  type DeploymentSummaryEntry,
  type EvaluationSummaryEntry,
  type FamilyMetrics,
  type ObservabilityReport
} from './observability/report.js';
export {
  DEFAULT_MINE_OPTIONS,
  mineSuccessfulPatterns,
  type MinePatternsOptions,
  type ToolPattern,
  type ToolPatternStep
} from './tools/subgraph.js';
export {
  ALLOWED_TOOL_PERMISSIONS,
  assertPermissionsAllowed,
  createSynthesizedTool,
  synthesizeTool,
  verifySynthesizedTool,
  SYNTHESIZED_TOOL_SCHEMA_VERSION,
  type SynthesizeToolOptions,
  type SynthesizedTool,
  type SynthesizedToolInput,
  type ToolOrigin,
  type ToolPermission
} from './tools/synthesized-tool.js';
export {
  ProcessToolTestRunner,
  runToolGates,
  type ProcessToolTestRunnerOptions,
  type ToolGateOptions,
  type ToolGateResult,
  type ToolTestResult,
  type ToolTestRunner
} from './tools/tool-gate.js';
export {
  DynamicToolRegistry,
  type DynamicToolRegistryOptions,
  type ToolRegistryEntry,
  type ToolStatus
} from './tools/tool-registry.js';
export {
  DEFAULT_MAX_OLD_SPACE_SIZE_MB,
  DEFAULT_MAX_OUTPUT_BYTES,
  runIsolatedChild,
  type ChildConfinement,
  type IsolatedChildResult,
  type RunIsolatedChildOptions
} from './operations/isolated-child.js';
export {
  advanceDeployment,
  createEvaluationReport,
  createPolicyArtifact,
  createPolicyArtifactWithSource,
  sealDeployment,
  verifyDeployment,
  verifyPolicyArtifactSource,
  DEPLOYMENT_SCHEMA_VERSION,
  POLICY_ARTIFACT_SCHEMA_VERSION,
  SIGNATURE_ALGORITHM,
  summarizeCanary,
  summarizeCaseResults,
  verifyEvaluationReport,
  verifyPolicyArtifact,
  type Approval,
  type ArtifactSignature,
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
  type HoldoutGateVerdict,
  type PolicyArtifact,
  type PolicyManifest,
  type RejectionReason
} from './registry/models.js';
export {
  canTransitionDeployment,
  isRollbackReachable,
  transitionDeployment
} from './registry/deployment-state.js';
export {
  AUDIT_SCHEMA_VERSION,
  createAuditEvent,
  verifyAuditEvent,
  FileAuditLog,
  InMemoryAuditLog,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventType,
  type AuditSubject,
  type AuditSink
} from './registry/audit.js';
export {
  DeploymentWriter,
  type DeploymentWriterOptions,
  type ProposeDeploymentInput,
  type RollbackInput,
  type SignatureVerifier,
  type SignatureVerdict
} from './registry/deployment-writer.js';
export {
  Ed25519SignatureVerifier,
  loadKeyRing,
  signEvaluationReport,
  signEvaluationSnapshot,
  signPolicyArtifact,
  type KeyRing,
  type KeyRingEntry,
  type SignArtifactInput
} from './registry/signing.js';
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
  toArtifactRef,
  type ArtifactKind,
  type ArtifactMetadata,
  type ArtifactRef,
  type ArtifactStore,
  type ArtifactVerification,
  type ArtifactVerificationFailure,
  type PutArtifactInput
} from './artifacts/store.js';
export { createReplayKey, replayKeyInputFromNode, REPLAY_KEY_SCHEMA_VERSION } from './replay/key.js';
export {
  ReplaySimulator,
  type CounterfactualBranch,
  type ReplayAction,
  type ReplayState
} from './replay/simulator.js';
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
  createRecordingLlm,
  LlmRecordingError,
  LLM_RECORD_SCHEMA_VERSION,
  type LlmCallRecord,
  type LlmRecorderOptions,
  type RecordingLlm
} from './evolution/llm-recorder.js';
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
export { evaluateReplayIsolated, type IsolatedEvaluatorOptions } from './evolution/isolated-evaluator.js';
export { splitDiscoveryNodes, bucketFor, DEFAULT_SPLIT_CONFIG } from './evolution/split.js';
export {
  ablateEvaluator,
  ablateSplit,
  buildAblationStudy,
  evaluatorAblations,
  ABLATION_SCHEMA_VERSION,
  type AblationRun,
  type AblationStudy,
  type AblationVariant,
  type SplitAblation
} from './evolution/ablation.js';
export { evaluateMonotonicGate, DEFAULT_MONOTONIC_GATE_CONFIG, type MonotonicGateConfig, type MonotonicGateResult, type PolicyCaseEvaluation } from './evolution/monotonic-gate.js';
export {
  evaluateHoldoutGate,
  DEFAULT_HOLDOUT_GATE_CONFIG,
  type HoldoutFamilyVerdict,
  type HoldoutGateConfig,
  type HoldoutGateInput,
  type HoldoutGateResult
} from './evolution/holdout-gate.js';
export {
  createEvaluationSnapshot,
  loadEvaluationSnapshot,
  persistEvaluationSnapshot,
  verifyEvaluationSnapshot,
  type EvaluationSnapshot,
  type SnapshotSignatureVerifier
} from './evolution/snapshot.js';
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
  verifyReadiness,
  type ReadinessCheck,
  type ReadinessInput,
  type ReadinessReport,
  type ReadinessState
} from './readiness.js';
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

export { narrowCapabilityProfile } from './embodied/capability.js';
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
  assertObservationSchema,
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
  type CounterfactualSummary,
  type EpisodeGates,
  type EpisodePipelineOptions,
  type EpisodePipelineResult,
  type EpisodePipelineSettings,
  type EpisodeReplay,
  type ReplayReport
} from './tasks/pipeline.js';

export const name = 'dream-rsi';

/**
 * Services this plugin waits for before `apply` runs.
 *
 * `ctx.tools` is a Cordis service, so it has to be declared or activation can
 * race the provider: reading an unprovided service throws "cannot get property
 * \"tools\" without inject". The core mixins (`effect`, `emit`) need no
 * declaration — they are on the context prototype, not in the service store.
 */
export const inject: string[] = ['tools'];

/**
 * Cordis entrypoint for the Dream-RSI plugin. All Cordis-specific wiring
 * lives in `adapter/cordis.ts` so the rest of the package stays testable
 * without a Cordis context.
 */
export { apply };

export {
  ROBOSUITE_FRAME_ID,
  toActionStatus,
  toActionResult,
  toBridgeRequest,
  toObservation,
  type ActionResultInput,
  type BridgeRequest,
  type BridgeState,
  type ObservationIdentity
} from './embodied/robosuite-mapping.js';
