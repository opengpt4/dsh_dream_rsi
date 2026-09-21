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

/** Objects a global may be reached through. `globalThis.eval` is `eval`. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

/**
 * The name an expression refers to, resolved through the wrappings that leave
 * it the same value: redundant parentheses, a comma expression's last operand
 * (the canonical `(0, eval)` indirect form), and a known global object's
 * property, including `globalThis["eval"]`.
 *
 * Returns `undefined` when the expression is not a name this guard tracks.
 */
export function resolveExpressionName(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return resolveExpressionName(expression.expression);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return resolveExpressionName(expression.right);
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    GLOBAL_OBJECTS.has(expression.expression.text)
  ) {
    return expression.name.text;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    GLOBAL_OBJECTS.has(expression.expression.text) &&
    expression.argumentExpression !== undefined &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

/**
 * Minimal AST-level guard for candidate policy/tool source. This is a
 * defense-in-depth building block, not a full sandbox: it rejects a known
 * set of dangerous syntax patterns so obviously unsafe candidates never
 * reach an isolated runner. It must be paired with process/container
 * isolation before untrusted candidate code executes (see BASELINE.md).
 *
 * A forbidden name is resolved through parentheses, a comma expression, and
 * known global objects, so `eval`, `(eval)`, `(0, eval)`, `globalThis.eval` and
 * `globalThis["eval"]` are one rule. What it still cannot see is an alias
 * (`const f = eval`) or code in a string that never appears as syntax — a
 * pattern list is not a sandbox, which is why the isolation above is required.
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
      } else {
        const callee = resolveExpressionName(node.expression);
        if (callee !== undefined && FORBIDDEN_CALLEE_NAMES.has(callee)) {
          report(node, 'forbidden-call', `call to "${callee}" is not allowed`);
        } else if (callee === 'require') {
          const [arg] = node.arguments;
          const moduleName = arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
          if (moduleName === undefined) {
            report(node, 'dynamic-require', 'require() with a non-literal argument is not allowed');
          } else {
            checkModuleSpecifier(node, moduleName);
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      const callee = resolveExpressionName(node.expression);
      if (callee !== undefined && FORBIDDEN_CALLEE_NAMES.has(callee)) {
        report(node, 'forbidden-call', `new ${callee}(...) is not allowed`);
      }
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      checkModuleSpecifier(node, node.moduleSpecifier.text);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const objectName = resolveExpressionName(node.expression);
      const propertyName = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression !== undefined && ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      if (
        objectName !== undefined &&
        propertyName !== undefined &&
        FORBIDDEN_MEMBER_ACCESS.some(([object, property]) => object === objectName && property === propertyName)
      ) {
        report(node, 'forbidden-member-access', `"${objectName}.${propertyName}" is not allowed`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return { passed: violations.length === 0, violations };
}
