import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANDIDATE_SCHEMA_VERSION,
  InMemoryPolicyRegistryStore,
  MOCK_ENVIRONMENT_ID,
  MUTATION_CLASSES,
  PolicyRegistry,
  assertMutationClassesAllowed,
  buildIdentifier,
  buildPrompt,
  createPolicyArtifact,
  evaluateCandidate,
  generateCandidate,
  hashDreamRsiConfig,
  parseCandidateProposal,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  createDreamRsiRuntime,
  runEpisodePipeline,
  verifyPolicyArtifact
} from '../dist/index.js';

const BENIGN_SOURCE = `export function decide(observation) {
  return observation.step + 1;
}`;

const METRICS = { quality: 1, cost: 0.1, parallelEfficiency: 1, missRate: 0, score: 1 };

function parent() {
  return createPolicyArtifact({
    version: 'v0',
    parentVersion: null,
    source: 'export const decide = () => 0;',
    manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
    allowedCapabilities: ['scheduling'],
    createdBy: 'human',
    createdAt: '2026-01-01T00:00:00.000Z'
  });
}

function reply(overrides = {}) {
  return {
    mutationClasses: ['scheduling'],
    rationale: 'reorder the frontier by depth',
    source: BENIGN_SOURCE,
    ...overrides
  };
}

/** Captures every request so a test can inspect what the model was actually sent. */
function fakeLlm(payload, sent = []) {
  return {
    sent,
    async invoke(request) {
      sent.push(request);
      return {
        text: typeof payload === 'string' ? payload : JSON.stringify(payload),
        model: request.model,
        usage: { inputTokens: 11, outputTokens: 22 },
        finishReason: 'stop'
      };
    }
  };
}

function generationInput(overrides = {}) {
  return {
    parent: parent(),
    parentSource: 'export const decide = () => 0;',
    trainMetrics: METRICS,
    validationMetrics: { ...METRICS, quality: 0.8 },
    seed: 'seed-1',
    model: 'deepseek-v4-flash',
    correlationId: 'correlation-1',
    ...overrides
  };
}

// ------------------------------------------------------------ mutation classes

test('only the spec mutation classes are permitted', () => {
  assert.deepEqual(MUTATION_CLASSES, ['scheduling', 'pruning', 'retry', 'parallelism', 'budget']);
  assert.deepEqual(assertMutationClassesAllowed(['scheduling', 'budget']), ['scheduling', 'budget']);
  assert.deepEqual(assertMutationClassesAllowed(['scheduling', 'scheduling']), ['scheduling']);

  assert.throws(() => assertMutationClassesAllowed([]), /at least one mutation class/);
  assert.throws(() => assertMutationClassesAllowed(['model-weights']), /not permitted: model-weights/);
  assert.throws(() => assertMutationClassesAllowed(['scheduling', 'secrets']), /not permitted: secrets/);
});

// --------------------------------------------------------------- prompt build

test('the prompt carries train and validation metrics but never holdout', async () => {
  const input = generationInput();
  // Extra properties a careless caller might attach. They must not reach the model.
  const poisoned = {
    ...input,
    holdoutMetrics: { quality: 0.99, marker: 'HOLDOUT-MARKER' },
    holdoutResults: [{ caseId: 'secret-case', marker: 'HOLDOUT-CASE-MARKER' }],
    evaluatorInternals: { marker: 'EVALUATOR-MARKER' },
    secrets: { apiKey: 'sk-SECRET-MARKER' },
    deploymentState: { marker: 'DEPLOYMENT-MARKER' }
  };

  const llm = fakeLlm(reply());
  await generateCandidate(llm, poisoned);

  const [request] = llm.sent;
  assert.match(request.prompt, /train metrics: /);
  assert.match(request.prompt, /validation metrics: /);
  for (const marker of ['HOLDOUT-MARKER', 'HOLDOUT-CASE-MARKER', 'EVALUATOR-MARKER', 'SECRET-MARKER', 'DEPLOYMENT-MARKER']) {
    assert.ok(!request.prompt.includes(marker), `${marker} leaked into the prompt`);
    assert.ok(!JSON.stringify(request).includes(marker), `${marker} leaked into the request`);
  }
});

test('the prompt names the seed, the parent version, and the permitted classes', () => {
  const prompt = buildPrompt(generationInput());

  assert.match(prompt, /^seed: seed-1$/m);
  assert.match(prompt, /^parent version: v0$/m);
  assert.match(prompt, /parent source:/);
});

test('the system instruction states the mutation boundary', async () => {
  const llm = fakeLlm(reply());
  await generateCandidate(llm, generationInput());

  const [request] = llm.sent;
  assert.match(request.system, /model is frozen/);
  for (const mutationClass of MUTATION_CLASSES) assert.match(request.system, new RegExp(mutationClass));
  assert.match(request.system, /deployment registry/);
});

// --------------------------------------------------------------------- parse

test('a well-formed reply becomes a proposal with a host-derived manifest', async () => {
  const llm = fakeLlm(reply({ dependencies: ['typescript'] }));
  const proposal = await generateCandidate(llm, generationInput());

  assert.deepEqual(proposal.mutationClasses, ['scheduling']);
  assert.equal(proposal.parentVersion, 'v0');
  assert.equal(proposal.seed, 'seed-1');
  assert.equal(proposal.source, BENIGN_SOURCE);
  assert.deepEqual(proposal.manifest, {
    entrypoint: 'src/policy.ts',
    dependencies: ['typescript'],
    schemaVersion: CANDIDATE_SCHEMA_VERSION
  });
  assert.deepEqual(proposal.usage, { inputTokens: 11, outputTokens: 22 });
  assert.match(proposal.buildId, /^[0-9a-f]{64}$/);
});

test('a reply wrapped in prose or a code fence is still parsed', () => {
  const context = { parent: parent(), seed: 'seed-1', usage: { inputTokens: 1, outputTokens: 1 } };
  const fenced = `Here is the policy:\n\`\`\`json\n${JSON.stringify(reply())}\n\`\`\`\nIt changes scheduling.`;

  assert.equal(parseCandidateProposal(fenced, context).source, BENIGN_SOURCE);
});

test('a malformed or incomplete reply is rejected rather than defaulted', () => {
  const context = { parent: parent(), seed: 'seed-1', usage: { inputTokens: 1, outputTokens: 1 } };

  assert.throws(() => parseCandidateProposal('no json here', context), /no JSON object/);
  assert.throws(() => parseCandidateProposal('{ not json }', context), /not valid JSON/);
  assert.throws(() => parseCandidateProposal('[]', context), /no JSON object/);
  assert.throws(() => parseCandidateProposal(JSON.stringify(reply({ mutationClasses: undefined })), context), /no mutationClasses/);
  assert.throws(() => parseCandidateProposal(JSON.stringify(reply({ rationale: '  ' })), context), /no rationale/);
  assert.throws(() => parseCandidateProposal(JSON.stringify(reply({ source: '' })), context), /no source/);
  assert.throws(() => parseCandidateProposal(JSON.stringify(reply({ dependencies: [1, 2] })), context), /array of strings/);
});

test('a forbidden mutation class is rejected before the source is considered', () => {
  const context = { parent: parent(), seed: 'seed-1', usage: { inputTokens: 1, outputTokens: 1 } };
  const attempt = reply({ mutationClasses: ['scheduling', 'model-weights'] });

  assert.throws(() => parseCandidateProposal(JSON.stringify(attempt), context), /not permitted: model-weights/);
});

// ----------------------------------------------------------- build identifier

test('the build identifier is a pure function of parent, source, manifest, and seed', () => {
  const base = { parentVersion: 'v0', sourceSha256: 'a'.repeat(64), manifest: { entrypoint: 'p.ts', dependencies: [], schemaVersion: 1 }, seed: 'seed-1' };
  const same = { ...base, manifest: { entrypoint: 'p.ts', dependencies: [], schemaVersion: 1 } };

  assert.equal(buildIdentifier(base), buildIdentifier(same));
  assert.notEqual(buildIdentifier(base), buildIdentifier({ ...base, seed: 'seed-2' }));
  assert.notEqual(buildIdentifier(base), buildIdentifier({ ...base, sourceSha256: 'b'.repeat(64) }));
  assert.notEqual(buildIdentifier(base), buildIdentifier({ ...base, parentVersion: 'v1' }));
  assert.notEqual(
    buildIdentifier(base),
    buildIdentifier({ ...base, manifest: { entrypoint: 'p.ts', dependencies: ['x'], schemaVersion: 1 } })
  );
});

test('two identical generations produce the same build identifier', async () => {
  const first = await generateCandidate(fakeLlm(reply()), generationInput());
  const second = await generateCandidate(fakeLlm(reply()), generationInput());

  assert.equal(first.buildId, second.buildId);
});

// ------------------------------------------------------------------ end to end

function runtimeAndRegistry() {
  return {
    runtime: createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } })),
    registry: new PolicyRegistry(new InMemoryPolicyRegistryStore())
  };
}

function pipelineOptions(runtime, registry, artifact, source) {
  return {
    task: {
      taskId: 'task-1',
      goal: 'reach x=1',
      environmentId: MOCK_ENVIRONMENT_ID,
      policyVersion: artifact.version,
      budget: { maxSteps: 2, wallClockMs: 30_000 },
      metadata: {}
    },
    episodeId: 'episode-1',
    sessionId: 'session-1',
    adapter: runtime.adapter,
    store: runtime.store,
    policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }]),
    isGoalReached: (observation) => observation.pose.x >= 1,
    settings: pipelineSettings(runtime),
    candidateSource: { source },
    reporting: {
      registry,
      policyArtifactId: artifact.artifactId,
      evaluatorVersion: '0.1.0',
      sourceHash: artifact.sourceSha256,
      configHash: hashDreamRsiConfig(runtime.config),
      split: 'validation',
      taskFamily: 'mock-room'
    }
  };
}

test('a generated candidate is scanned, registered, and evaluated without being promoted', async () => {
  const { runtime, registry } = runtimeAndRegistry();
  try {
    const incumbent = parent();
    registry.registerPolicy(incumbent);
    let evaluatedArtifact = null;

    const result = await evaluateCandidate({
      llm: fakeLlm(reply()),
      generation: generationInput({ parent: incumbent }),
      registry,
      candidateRoot: process.cwd(),
      evaluate: async (artifact) => {
        evaluatedArtifact = artifact;
        const run = await runEpisodePipeline(pipelineOptions(runtime, registry, artifact, BENIGN_SOURCE));
        return run.report;
      }
    });

    assert.equal(result.promoted, false);
    assert.equal(result.staticGate.passed, true);
    assert.equal(evaluatedArtifact.artifactId, result.artifact.artifactId);
    assert.equal(result.artifact.createdBy, 'evolution-agent');
    // Declared capabilities come from the approved mutation classes, nothing else.
    assert.deepEqual(result.artifact.allowedCapabilities, ['scheduling']);
    assert.equal(result.artifact.parentVersion, 'v0');
    assert.equal(verifyPolicyArtifact(result.artifact), true);
    assert.match(result.artifact.version, /^v0\+[0-9a-f]{8}$/);

    // Both the incumbent and the candidate are registered; the report is persisted.
    assert.equal(registry.policyCount(), 2);
    assert.equal(registry.evaluation(result.report.evaluationId).policyArtifactId, result.artifact.artifactId);

    // Evaluating is not deploying: the pointer still points at the incumbent.
    assert.equal(registry.currentPolicyArtifactId(), null);
    assert.deepEqual(registry.listDeployments(), []);
  } finally {
    runtime.dispose();
  }
});

test('a candidate that trips the gate registers nothing and is never evaluated', async () => {
  const { runtime, registry } = runtimeAndRegistry();
  try {
    const incumbent = parent();
    registry.registerPolicy(incumbent);
    let evaluationCalls = 0;

    await assert.rejects(
      evaluateCandidate({
        llm: fakeLlm(reply({ source: "const leak = process.env.SECRET; export const decide = () => leak;" })),
        generation: generationInput({ parent: incumbent }),
        registry,
        candidateRoot: process.cwd(),
        evaluate: async () => {
          evaluationCalls += 1;
          throw new Error('should not be reached');
        }
      }),
      /candidate .* rejected by .* guard rule\(s\)/
    );

    assert.equal(evaluationCalls, 0, 'a rejected candidate must not be evaluated');
    assert.equal(registry.policyCount(), 1, 'a rejected candidate must not be registered');
    assert.equal(registry.evaluationCount(), 0);
    assert.equal(registry.currentPolicyArtifactId(), null);
  } finally {
    runtime.dispose();
  }
});

test('generation cannot reach the registry on its own', async () => {
  const llm = fakeLlm(reply());
  const proposal = await generateCandidate(llm, generationInput());

  // The generator returns a proposal and nothing else: no artifact, no pointer.
  assert.deepEqual(Object.keys(proposal).sort(), [
    'buildId',
    'manifest',
    'mutationClasses',
    'parentVersion',
    'rationale',
    'seed',
    'source',
    'usage'
  ]);
});
