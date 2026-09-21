/**
 * The action state machine from the design spec, as data.
 *
 * Edges are exactly those in the spec diagram. `AUTHORIZED -> CANCELLED` is how
 * a stop that lands in the authorize window is recorded; the stop itself is
 * latched, so the next request fails at `REQUESTED` rather than reaching here.
 */

export type ActionState =
  | 'REQUESTED'
  | 'AUTHORIZED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'EMERGENCY_STOP';

const TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  REQUESTED: ['AUTHORIZED', 'FAILED'],
  AUTHORIZED: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'EMERGENCY_STOP'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMEOUT: [],
  EMERGENCY_STOP: []
};

export function canTransition(from: ActionState, to: ActionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Terminal states absorb: no transition out of one is legal. */
export function transition(from: ActionState, to: ActionState): ActionState {
  if (!canTransition(from, to)) throw new Error(`illegal action transition ${from} -> ${to}`);
  return to;
}

/** Maps an action outcome onto the state it terminates in. */
export function terminalStateFor(status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'emergency_stop'): ActionState {
  return status.toUpperCase() as ActionState;
}
