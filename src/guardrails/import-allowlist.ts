import { isAbsolute, relative, resolve } from 'node:path';

import ts from 'typescript';

import { resolveExpressionName } from './ast-guard.js';

/**
 * Static import and capability allowlist for candidate policy/tool source.
 *
 * The AST guard rejects specific dangerous syntax. This is the other half: an
 * allowlist, so a specifier nobody approved is denied even when it is not on a
 * known-bad list. It is still a prefilter, never the security boundary.
 */

export type ImportKind = 'relative' | 'builtin' | 'package' | 'dynamic';

/** What reaching a module would grant the candidate. */
export type Capability = 'filesystem' | 'network' | 'process' | 'secrets' | 'code-generation' | 'concurrency';

export interface ImportViolation {
  readonly rule: string;
  readonly message: string;
  readonly specifier: string;
  readonly line: number;
  readonly column: number;
  readonly capability?: Capability;
}

export interface ImportAllowlistResult {
  readonly passed: boolean;
  readonly violations: readonly ImportViolation[];
  /** Every module specifier the source names, in source order. */
  readonly specifiers: readonly string[];
  /** Capabilities those specifiers would grant, deduplicated. */
  readonly capabilities: readonly Capability[];
}

export interface ImportAllowlistOptions {
  readonly allowedPackages?: readonly string[];
  /** Built-ins the candidate may import. Empty means none. */
  readonly allowedBuiltins?: readonly string[];
  /** When set, a relative import resolving outside this directory is a violation. */
  readonly candidateRoot?: string;
  readonly fileName?: string;
}

const BUILTIN_CAPABILITIES: Readonly<Record<string, Capability>> = {
  child_process: 'process',
  cluster: 'concurrency',
  dgram: 'network',
  dns: 'network',
  fs: 'filesystem',
  'fs/promises': 'filesystem',
  http: 'network',
  http2: 'network',
  https: 'network',
  net: 'network',
  process: 'secrets',
  tls: 'network',
  vm: 'code-generation',
  worker_threads: 'concurrency'
};

export function checkImports(source: string, options: ImportAllowlistOptions = {}): ImportAllowlistResult {
  const allowedPackages = new Set(options.allowedPackages ?? []);
  const allowedBuiltins = new Set(options.allowedBuiltins ?? []);
  const sourceFile = ts.createSourceFile(
    options.fileName ?? 'candidate.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const violations: ImportViolation[] = [];
  const specifiers: string[] = [];
  const capabilities = new Set<Capability>();

  const report = (
    node: ts.Node,
    rule: string,
    message: string,
    specifier: string,
    capability?: Capability
  ): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      rule,
      message,
      specifier,
      line: line + 1,
      column: character + 1,
      ...(capability !== undefined ? { capability } : {})
    });
  };

  const inspect = (node: ts.Node, specifier: string, kind: ImportKind): void => {
    specifiers.push(specifier);

    if (kind === 'dynamic') {
      report(node, 'dynamic-import', 'dynamic import() of a module is not allowed', specifier);
      return;
    }

    if (kind === 'relative') {
      if (options.candidateRoot !== undefined && escapesRoot(specifier, options.candidateRoot)) {
        report(node, 'relative-escape', `relative import "${specifier}" resolves outside the candidate root`, specifier);
      }
      return;
    }

    if (kind === 'package') {
      const name = packageNameOf(specifier);
      if (!allowedPackages.has(name)) {
        report(node, 'package-not-allowed', `package "${name}" is not on the allowlist`, specifier);
      }
      return;
    }

    const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
    const capability = builtinCapability(bare);

    // A capability-granting built-in is never allowlistable: approving it by
    // name would make the profile meaningless.
    if (capability !== undefined) {
      capabilities.add(capability);
      report(
        node,
        `capability-${capability}`,
        `importing "${specifier}" would grant the ${capability} capability`,
        specifier,
        capability
      );
      return;
    }

    // `assert/strict` is allowed by allowing `assert`: a subpath does not grant
    // a capability its parent lacks, and requiring every subpath by name would
    // make the allowlist unusable.
    if (!allowedBuiltins.has(bare) && !allowedBuiltins.has(topLevel(bare))) {
      report(node, 'builtin-not-allowed', `built-in module "${specifier}" is not on the allowlist`, specifier);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      inspect(node, node.moduleSpecifier.text, classify(node.moduleSpecifier.text));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      inspect(node, node.moduleSpecifier.text, classify(node.moduleSpecifier.text));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      inspect(node, node.moduleReference.expression.text, classify(node.moduleReference.expression.text));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      inspect(node, argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : '<computed>', 'dynamic');
    } else if (
      ts.isCallExpression(node) &&
      // Resolved rather than matched on the bare identifier: `globalThis.require`
      // names the same function, and a module load that reaches the allowlist in
      // no other way must not skip it.
      resolveExpressionName(node.expression) === 'require'
    ) {
      const [argument] = node.arguments;
      const specifier = argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
      if (specifier === undefined) {
        report(node, 'dynamic-require', 'require() with a non-literal argument is not allowed', '<computed>');
      } else {
        inspect(node, specifier, classify(specifier));
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    passed: violations.length === 0,
    violations,
    specifiers,
    capabilities: [...capabilities].sort()
  };
}

/** `@scope/name` keeps two segments; anything else keeps the first. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function classify(specifier: string): ImportKind {
  if (specifier.startsWith('.') || isAbsolute(specifier)) return 'relative';
  if (specifier.startsWith('node:')) return 'builtin';
  return isBuiltinName(specifier) ? 'builtin' : 'package';
}

/** `assert/strict` and `path/posix` are built-ins because their parent is. */
function topLevel(specifier: string): string {
  return specifier.split('/')[0]!;
}

function isBuiltinName(specifier: string): boolean {
  return (
    specifier in BUILTIN_CAPABILITIES ||
    HARMLESS_BUILTINS.has(specifier) ||
    HARMLESS_BUILTINS.has(topLevel(specifier)) ||
    topLevel(specifier) in BUILTIN_CAPABILITIES
  );
}

/** A subpath inherits its parent's capability, so capability checks cannot be evaded by one. */
function builtinCapability(bare: string): Capability | undefined {
  return BUILTIN_CAPABILITIES[bare] ?? BUILTIN_CAPABILITIES[topLevel(bare)];
}

/**
 * Built-ins with no capability worth naming. Kept explicit: an unlisted
 * built-in falls to the package allowlist and is denied by default, so a new
 * Node release cannot silently widen what a candidate may reach.
 */
const HARMLESS_BUILTINS = new Set([
  'assert', 'buffer', 'crypto', 'events', 'path', 'punycode', 'querystring',
  'stream', 'string_decoder', 'timers', 'url', 'util', 'zlib'
]);

function escapesRoot(specifier: string, candidateRoot: string): boolean {
  const root = resolve(candidateRoot);
  const resolved = resolve(root, specifier);
  const relativePath = relative(root, resolved);
  return relativePath.startsWith('..') || isAbsolute(relativePath);
}
