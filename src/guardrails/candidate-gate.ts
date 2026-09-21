import { runAstGuard, type AstGuardResult } from './ast-guard.js';
import { checkImports, type Capability, type ImportAllowlistResult } from './import-allowlist.js';

/**
 * The prefilter a candidate must clear before it is evaluated or executed.
 *
 * Two independent checks over the same source: the AST guard rejects specific
 * dangerous syntax, and the import allowlist denies everything not approved.
 * Neither is the security boundary — candidates that pass still run isolated.
 */

export interface CandidateGateOptions {
  readonly source: string;
  readonly fileName?: string;
  /** Relative imports resolving outside this directory are rejected. */
  readonly candidateRoot?: string;
  readonly allowedPackages?: readonly string[];
  readonly allowedBuiltins?: readonly string[];
}

export interface CandidateGateResult {
  readonly passed: boolean;
  readonly ast: AstGuardResult;
  readonly imports: ImportAllowlistResult;
  /** Every module the candidate names, in source order. */
  readonly specifiers: readonly string[];
  /** Capabilities the candidate would need, deduplicated. */
  readonly capabilities: readonly Capability[];
}

export function scanCandidate(options: CandidateGateOptions): CandidateGateResult {
  const ast = runAstGuard(options.source, options.fileName ?? 'candidate.ts');
  const imports = checkImports(options.source, {
    ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
    ...(options.candidateRoot !== undefined ? { candidateRoot: options.candidateRoot } : {}),
    ...(options.allowedPackages !== undefined ? { allowedPackages: options.allowedPackages } : {}),
    ...(options.allowedBuiltins !== undefined ? { allowedBuiltins: options.allowedBuiltins } : {})
  });

  return {
    passed: ast.passed && imports.passed,
    ast,
    imports,
    specifiers: imports.specifiers,
    capabilities: imports.capabilities
  };
}

/** Fail closed: throw with every violation rather than returning a verdict. */
export function assertCandidateAccepted(options: CandidateGateOptions): CandidateGateResult {
  const result = scanCandidate(options);
  if (result.passed) return result;

  const reasons = [
    ...result.ast.violations.map((violation) => `${violation.rule} at ${violation.line}:${violation.column}`),
    ...result.imports.violations.map((violation) => `${violation.rule} at ${violation.line}:${violation.column}`)
  ];
  throw new Error(`candidate rejected by ${reasons.length} guard rule(s): ${reasons.join('; ')}`);
}
