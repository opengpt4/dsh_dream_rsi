import ts from 'typescript';

export interface AstGuardViolation {
  readonly rule: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export interface AstGuardResult {
  readonly passed: boolean;
  readonly violations: readonly AstGuardViolation[];
}

/**
 * Forbidden call targets per FUNCTIONAL_SPEC.md section 7 (`eval`, `exec`,
 * `compile`, dynamic code execution primitives).
 */
const FORBIDDEN_CALLEE_NAMES = new Set(['eval', 'Function', 'execSync', 'exec', 'execFileSync', 'execFile', 'spawnSync']);

/** Node built-ins that grant filesystem, process, or network capability. */
const FORBIDDEN_MODULE_SPECIFIERS = new Set([
  'child_process',
  'node:child_process',
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'net',
  'node:net',
  'dgram',
  'node:dgram',
  'tls',
  'node:tls',
  'http',
  'node:http',
  'https',
  'node:https',
  'vm',
  'node:vm',
  'worker_threads',
  'node:worker_threads',
  'cluster',
  'node:cluster'
]);

/** `object.property` pairs that read secrets or grant uncontrolled process control. */
const FORBIDDEN_MEMBER_ACCESS: ReadonlyArray<readonly [string, string]> = [
  ['process', 'env'],
  ['process', 'binding'],
  ['process', 'exit'],
  ['process', 'kill'],
  ['process', 'mainModule']
];

/**
 * Minimal AST-level guard for candidate policy/tool source. This is a
 * defense-in-depth building block, not a full sandbox: it rejects a known
 * set of dangerous syntax patterns so obviously unsafe candidates never
 * reach an isolated runner. It must be paired with process/container
 * isolation before untrusted candidate code executes (see BASELINE.md).
 */
export function runAstGuard(source: string, fileName = 'candidate.ts'): AstGuardResult {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: AstGuardViolation[] = [];

  const report = (node: ts.Node, rule: string, message: string): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ rule, message, line: line + 1, column: character + 1 });
  };

  const checkModuleSpecifier = (node: ts.Node, moduleName: string | undefined): void => {
    if (moduleName !== undefined && FORBIDDEN_MODULE_SPECIFIERS.has(moduleName)) {
      report(node, 'forbidden-module', `module "${moduleName}" is not allowed`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        report(node, 'dynamic-import', 'dynamic import() is not allowed');
      } else if (ts.isIdentifier(node.expression) && FORBIDDEN_CALLEE_NAMES.has(node.expression.text)) {
        report(node, 'forbidden-call', `call to "${node.expression.text}" is not allowed`);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const [arg] = node.arguments;
        const moduleName = arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
        if (moduleName === undefined) {
          report(node, 'dynamic-require', 'require() with a non-literal argument is not allowed');
        } else {
          checkModuleSpecifier(node, moduleName);
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && FORBIDDEN_CALLEE_NAMES.has(node.expression.text)) {
      report(node, 'forbidden-call', `new ${node.expression.text}(...) is not allowed`);
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      checkModuleSpecifier(node, node.moduleSpecifier.text);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const objectName = node.expression.text;
      const propertyName = node.name.text;
      if (FORBIDDEN_MEMBER_ACCESS.some(([object, property]) => object === objectName && property === propertyName)) {
        report(node, 'forbidden-member-access', `"${objectName}.${propertyName}" is not allowed`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return { passed: violations.length === 0, violations };
}
