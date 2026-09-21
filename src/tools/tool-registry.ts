import type { GuardResult } from '../registry/models.js';
import { verifySynthesizedTool, type SynthesizedTool } from './synthesized-tool.js';

/**
 * Dynamic tool registry: versioned, reviewable, and reversible.
 *
 * A tool enters as a `candidate` and is selectable only while `enabled`. A
 * disabled tool is invisible to task selection rather than merely discouraged.
 * At most one version of a name is enabled: enabling another supersedes it, and
 * a rollback re-enables the version that was live before.
 */

export type ToolStatus = 'candidate' | 'enabled' | 'disabled';

export interface ToolRegistryEntry {
  readonly toolId: string;
  readonly name: string;
  readonly version: string;
  readonly status: ToolStatus;
  /** Version to restore on rollback: whatever was enabled before this one. */
  readonly previousToolId: string | null;
  readonly operator: string | null;
  readonly reason?: string;
  readonly gateResults: readonly GuardResult[];
  readonly updatedAt: string;
}

export interface DynamicToolRegistryOptions {
  readonly now?: () => Date;
}

export class DynamicToolRegistry {
  private readonly tools = new Map<string, SynthesizedTool>();
  private readonly entries = new Map<string, ToolRegistryEntry>();
  private readonly log: ToolRegistryEntry[] = [];
  private readonly now: () => Date;

  constructor(options: DynamicToolRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Record a tool and its gate verdict. Nothing is selectable yet. */
  propose(tool: SynthesizedTool, gateResults: readonly GuardResult[]): ToolRegistryEntry {
    if (!verifySynthesizedTool(tool)) throw new Error(`tool ${tool.toolId} does not match its content`);
    const existing = this.entries.get(tool.toolId);
    if (existing !== undefined) return existing;

    this.tools.set(tool.toolId, tool);
    return this.record({
      toolId: tool.toolId,
      name: tool.name,
      version: tool.version,
      status: 'candidate',
      previousToolId: null,
      operator: null,
      gateResults: [...gateResults],
      updatedAt: this.timestamp()
    });
  }

  /**
   * Enable a candidate. Requires an operator and a clean gate: a tool with any
   * failed guard cannot be enabled by supplying a different verdict later.
   */
  enable(toolId: string, operator: string, reason?: string): ToolRegistryEntry {
    const entry = this.require(toolId);
    if (entry.status === 'enabled') throw new Error(`tool ${toolId} is already enabled`);
    if (operator.trim().length === 0) throw new Error('enabling a tool requires an operator');
    const failed = entry.gateResults.filter((result) => !result.passed);
    if (failed.length > 0 || entry.gateResults.length === 0) {
      throw new Error(`tool ${toolId} cannot be enabled: ${failed.length} failed gate(s)`);
    }

    // Enabling a version supersedes whatever is live under that name, so a name
    // resolves to exactly one version. Leaving both enabled meant `resolve`
    // returned whichever was inserted first -- the oldest -- and rollback then
    // targeted that one and failed for having no previous version.
    const current = this.enabledForName(entry.name);
    if (current !== undefined && current.toolId !== entry.toolId) {
      this.record({
        ...current,
        status: 'disabled',
        operator,
        reason: reason ?? `superseded by ${entry.version}`,
        updatedAt: this.timestamp()
      });
    }

    // Built field by field rather than spread, so a previous disable reason is
    // not carried into an enabled record.
    return this.record({
      toolId: entry.toolId,
      name: entry.name,
      version: entry.version,
      status: 'enabled',
      previousToolId: current?.toolId ?? null,
      operator,
      ...(reason !== undefined ? { reason } : {}),
      gateResults: [...entry.gateResults],
      updatedAt: this.timestamp()
    });
  }

  disable(toolId: string, operator: string, reason: string): ToolRegistryEntry {
    const entry = this.require(toolId);
    if (entry.status === 'disabled') throw new Error(`tool ${toolId} is already disabled`);
    return this.record({
      ...entry,
      status: 'disabled',
      operator,
      reason,
      updatedAt: this.timestamp()
    });
  }

  /**
   * Restore the version that was live before the current one.
   *
   * The current version is disabled and the previous one re-enabled, so the
   * registry never shows two enabled versions of one tool name.
   */
  rollback(name: string, operator: string, reason: string): ToolRegistryEntry {
    const current = this.enabledForName(name);
    if (current === undefined) throw new Error(`no enabled tool named ${name} to roll back`);
    if (current.previousToolId === null) throw new Error(`tool ${name} has no previous version to roll back to`);

    // Enabling the previous version supersedes the current one, so the two
    // steps are one and the current version is recorded as disabled with the
    // operator's reason rather than an internal one.
    return this.enable(current.previousToolId, operator, reason);
  }

  entry(toolId: string): ToolRegistryEntry | undefined {
    const entry = this.entries.get(toolId);
    return entry === undefined ? undefined : { ...entry };
  }

  /** Every version of one tool name, in the order they were proposed. */
  versions(name: string): readonly ToolRegistryEntry[] {
    // Insertion order is proposal order. Sorting by `updatedAt` would reorder
    // versions every time one of them changed status, and ties would fall
    // wherever the sort left them.
    return [...this.entries.values()].filter((entry) => entry.name === name);
  }

  /** Tools a new task may select. Disabled tools are absent, not deprioritised. */
  selectable(): readonly SynthesizedTool[] {
    return [...this.entries.values()]
      .filter((entry) => entry.status === 'enabled')
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => this.tools.get(entry.toolId)!);
  }

  /** Resolve a tool by name for task selection. Returns nothing when disabled. */
  resolve(name: string): SynthesizedTool | undefined {
    const enabled = this.enabledForName(name);
    return enabled === undefined ? undefined : this.tools.get(enabled.toolId);
  }

  isSelectable(toolId: string): boolean {
    return this.entries.get(toolId)?.status === 'enabled';
  }

  /** Every transition, in order. */
  history(): readonly ToolRegistryEntry[] {
    return [...this.log];
  }

  private enabledForName(name: string): ToolRegistryEntry | undefined {
    return [...this.entries.values()].find((entry) => entry.name === name && entry.status === 'enabled');
  }

  private require(toolId: string): ToolRegistryEntry {
    const entry = this.entries.get(toolId);
    if (entry === undefined) throw new Error(`unknown tool ${toolId}`);
    return entry;
  }

  private record(entry: ToolRegistryEntry): ToolRegistryEntry {
    this.entries.set(entry.toolId, entry);
    this.log.push(entry);
    return { ...entry };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
