import type { DiscoveryNode, JsonValue } from '../discovery/models.js';
import { hashJson } from '../hash.js';

export const REPLAY_KEY_SCHEMA_VERSION = 1;

export interface ReplayKeyInput {
  readonly environmentVersion: string;
  readonly stateHash: string;
  readonly actionType: string;
  readonly normalizedActionParams: JsonValue;
  readonly observationHash: string;
}

export { canonicalJson, hashJson } from '../hash.js';

export function createReplayKey(input: ReplayKeyInput): string {
  return hashJson({
    schemaVersion: REPLAY_KEY_SCHEMA_VERSION,
    environmentVersion: input.environmentVersion,
    stateHash: input.stateHash,
    actionType: input.actionType,
    normalizedActionParams: input.normalizedActionParams,
    observationHash: input.observationHash
  });
}

/**
 * The decision a recorded node represents. Replaying a node means re-issuing
 * exactly this input, so the key a writer produced and the key a reader looks
 * up can never diverge.
 */
export function replayKeyInputFromNode(node: DiscoveryNode): ReplayKeyInput {
  return {
    environmentVersion: node.environmentVersion,
    stateHash: node.stateHash,
    actionType: node.actionType,
    normalizedActionParams: node.actionParams,
    observationHash: node.observationHash
  };
}
