import type { DiscoveryNode, JsonValue } from '../discovery/models.js';
import { canonicalJson } from '../hash.js';

/**
 * Mine repeated successful action sequences from the Discovery DAG.
 *
 * A pattern is evidence-backed work: the same ordered sequence of actions that
 * succeeded in more than one run. Only completed steps are considered, so a
 * sequence that ever failed is not offered as a tool.
 */

export interface ToolPatternStep {
  readonly actionType: string;
  readonly actionParams: JsonValue;
}

export interface ToolPattern {
  /** Canonical identity, e.g. `move_relative({"dx":1})->pick({"objectId":"mug"})`. */
  readonly signature: string;
  readonly steps: readonly ToolPatternStep[];
  /** Node ids evidencing this pattern, one entry per occurrence. */
  readonly supportingNodeIds: readonly string[];
  /** Distinct tasks the pattern was observed in. */
  readonly tasks: readonly string[];
}

export interface MinePatternsOptions {
  readonly minSteps?: number;
  readonly minOccurrences?: number;
  readonly maxSteps?: number;
}

export const DEFAULT_MINE_OPTIONS: Required<MinePatternsOptions> = {
  minSteps: 2,
  minOccurrences: 2,
  maxSteps: 8
};

export function mineSuccessfulPatterns(
  nodes: readonly DiscoveryNode[],
  options: MinePatternsOptions = {}
): readonly ToolPattern[] {
  const config = { ...DEFAULT_MINE_OPTIONS, ...options };
  if (!Number.isInteger(config.minSteps) || config.minSteps < 1) throw new Error('minSteps must be a positive integer');
  if (!Number.isInteger(config.minOccurrences) || config.minOccurrences < 1) {
    throw new Error('minOccurrences must be a positive integer');
  }
  if (config.maxSteps < config.minSteps) throw new Error('maxSteps must be at least minSteps');

  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenOf = new Map<string, DiscoveryNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node]);
  }

  // A run starts where no successful parent precedes it and continues while the
  // chain is unbroken: one successful child at a time.
  const runs: DiscoveryNode[][] = [];
  for (const node of nodes) {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    if (parent !== undefined && isSuccess(parent)) continue;
    if (!isSuccess(node)) continue;

    const run: DiscoveryNode[] = [node];
    let current = node;
    while (true) {
      const children = childrenOf.get(current.nodeId) ?? [];
      if (children.length !== 1 || !isSuccess(children[0]!)) break;
      current = children[0]!;
      run.push(current);
    }
    runs.push(run);
  }

  const bySignature = new Map<string, { steps: ToolPatternStep[]; occurrences: DiscoveryNode[][]; tasks: Set<string> }>();

  for (const run of runs) {
    for (let length = config.minSteps; length <= Math.min(config.maxSteps, run.length); length += 1) {
      for (let start = 0; start + length <= run.length; start += 1) {
        const window = run.slice(start, start + length);
        const steps = window.map((node) => ({ actionType: node.actionType, actionParams: node.actionParams }));
        const signature = steps.map((step) => `${step.actionType}(${canonicalJson(step.actionParams)})`).join('->');
        const entry = bySignature.get(signature) ?? { steps, occurrences: [], tasks: new Set<string>() };
        entry.occurrences.push(window);
        for (const node of window) entry.tasks.add(node.taskId);
        bySignature.set(signature, entry);
      }
    }
  }

  return [...bySignature.entries()]
    .filter(([, entry]) => entry.occurrences.length >= config.minOccurrences)
    .map(([signature, entry]) => ({
      signature,
      steps: entry.steps,
      supportingNodeIds: entry.occurrences.map((occurrence) => occurrence[0]!.nodeId),
      tasks: [...entry.tasks].sort()
    }))
    .sort((left, right) =>
      right.supportingNodeIds.length - left.supportingNodeIds.length || left.signature.localeCompare(right.signature)
    );
}

/** A step counts as successful only when the recorded action result says so. */
function isSuccess(node: DiscoveryNode): boolean {
  const result = node.result;
  return typeof result === 'object' && result !== null && !Array.isArray(result) && result.status === 'completed';
}
