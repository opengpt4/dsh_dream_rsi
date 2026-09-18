export interface PolicyCaseEvaluation {
  readonly caseId: string;
  readonly quality: number;
  readonly score: number;
}

export interface MonotonicGateConfig {
  readonly minimumPassRatio: number;
  readonly minimumImprovement: number;
}

export interface MonotonicGateResult {
  readonly passed: boolean;
  readonly passRatio: number;
  readonly scoreImprovement: number;
  readonly failedCaseIds: readonly string[];
  readonly reasons: readonly string[];
}

export const DEFAULT_MONOTONIC_GATE_CONFIG: MonotonicGateConfig = {
  minimumPassRatio: 0.95,
  minimumImprovement: 0.01
};

export function evaluateMonotonicGate(
  current: readonly PolicyCaseEvaluation[],
  candidate: readonly PolicyCaseEvaluation[],
  config: MonotonicGateConfig = DEFAULT_MONOTONIC_GATE_CONFIG
): MonotonicGateResult {
  validateConfig(config);
  const currentByCase = new Map(current.map((item) => [item.caseId, item]));
  const candidateByCase = new Map(candidate.map((item) => [item.caseId, item]));
  const failedCaseIds: string[] = [];
  let passedCases = 0;
  let currentScore = 0;
  let candidateScore = 0;

  for (const [caseId, currentCase] of currentByCase) {
    const candidateCase = candidateByCase.get(caseId);
    currentScore += currentCase.score;
    if (candidateCase === undefined) {
      failedCaseIds.push(caseId);
      continue;
    }
    candidateScore += candidateCase.score;
    if (candidateCase.quality >= currentCase.quality) passedCases += 1;
    else failedCaseIds.push(caseId);
  }

  const caseCount = currentByCase.size;
  const passRatio = caseCount === 0 ? 0 : passedCases / caseCount;
  const missingCaseIds = [...currentByCase.keys()].filter((caseId) => !candidateByCase.has(caseId));
  const extraCaseIds = [...candidateByCase.keys()].filter((caseId) => !currentByCase.has(caseId));
  const scoreImprovement = candidateByCase.size === 0
    ? Number.NEGATIVE_INFINITY
    : candidateScore / Math.max(caseCount, 1) - currentScore / Math.max(caseCount, 1);
  const reasons: string[] = [];
  if (caseCount === 0) reasons.push('no baseline cases were provided');
  if (missingCaseIds.length > 0 || extraCaseIds.length > 0) reasons.push('candidate and baseline case sets do not match');
  if (passRatio < config.minimumPassRatio) reasons.push('quality pass ratio is below the configured threshold');
  if (scoreImprovement < config.minimumImprovement) reasons.push('candidate score improvement is below the configured threshold');

  return {
    passed: reasons.length === 0,
    passRatio,
    scoreImprovement,
    failedCaseIds,
    reasons
  };
}

function validateConfig(config: MonotonicGateConfig): void {
  if (!Number.isFinite(config.minimumPassRatio) || config.minimumPassRatio < 0 || config.minimumPassRatio > 1) {
    throw new Error('minimumPassRatio must be between 0 and 1');
  }
  if (!Number.isFinite(config.minimumImprovement)) {
    throw new Error('minimumImprovement must be finite');
  }
}