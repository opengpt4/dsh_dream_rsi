import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../dist/index.js';

const TOOL_NAMES = [
  'dream_status',
  'embodied_act',
  'embodied_perceive',
  'embodied_query_state'
];

/**
 * Minimal Cordis context.
 *
 * `effect` mirrors the real contract: the setup callback runs immediately and
 * returns the disposer, so a callback that throws registers nothing. Tools
 * reject duplicate names, which is what makes a repeated mount observable.
 *
 * Registration surfaces this plugin must not reach are recorded in `foreign`
 * rather than omitted, so an accidental new registration shows up as a failure
 * instead of passing silently.
 */
function createFakeContext({ failOnToolName } = {}) {
  const tools = [];
  const effects = [];
  const events = [];
  const foreign = [];

  const context = {
    tools: {
      register(definition) {
        if (definition.name === failOnToolName) {
          throw new Error(`tool ${definition.name} rejected`);
        }
        if (tools.some((registered) => registered.name === definition.name)) {
          throw new Error(`tool ${definition.name} already registered`);
        }
        tools.push(definition);
        return () => {
          const index = tools.indexOf(definition);
          if (index >= 0) tools.splice(index, 1);
        };
      }
    },
    effect(execute, label) {
      const dispose = execute();
      const entry = { label, dispose };
      effects.push(entry);
      return () => {
        const index = effects.indexOf(entry);
        if (index >= 0) effects.splice(index, 1);
        dispose();
      };
    },
    emit(event, payload) {
      events.push({ event, payload });
    },
    provide(...args) {
      foreign.push(['provide', ...args]);
    },
    command(...args) {
      foreign.push(['command', ...args]);
    },
    worker(...args) {
      foreign.push(['worker', ...args]);
    },
    on(...args) {
      foreign.push(['on', ...args]);
    }
  };

  return {
    context,
    tools,
    effects,
    events,
    foreign,
    /** Mirrors fiber unload: effects dispose in reverse registration order. */
    unload() {
      for (const entry of [...effects].reverse()) entry.dispose();
      effects.length = 0;
    }
  };
}

test('mount registers the four tools and reaches no other registration surface', () => {
  const { context, tools, foreign } = createFakeContext();
  apply(context);

  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);
  assert.deepEqual(foreign, []);
});

test('unload leaves zero tool and effect residue', () => {
  const { context, tools, effects, unload } = createFakeContext();
  apply(context);
  assert.equal(tools.length, 4);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].label, 'dream-rsi/tools');

  unload();

  assert.deepEqual(tools, []);
  assert.deepEqual(effects, []);
});

test('a failure partway through registration rolls back the tools already registered', () => {
  const { context, tools, effects } = createFakeContext({ failOnToolName: 'embodied_query_state' });

  assert.throws(() => apply(context), /embodied_query_state rejected/);

  assert.deepEqual(tools, []);
  assert.deepEqual(effects, []);
});

test('a duplicate mount fails and leaves the first mount intact', () => {
  const { context, tools, unload } = createFakeContext();
  apply(context);
  const afterFirstMount = tools.map((tool) => tool.name).sort();
  assert.deepEqual(afterFirstMount, TOOL_NAMES);

  assert.throws(() => apply(context), /already registered/);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);

  unload();
  assert.deepEqual(tools, []);
});

test('reload after unload re-registers the same tools', () => {
  const { context, tools, unload } = createFakeContext();
  apply(context);
  unload();
  assert.deepEqual(tools, []);

  apply(context);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);

  unload();
  assert.deepEqual(tools, []);
});

test('a disabled config registers nothing', () => {
  const { context, tools, effects } = createFakeContext();
  apply(context, { enabled: false });

  assert.deepEqual(tools, []);
  assert.deepEqual(effects, []);
});

test('invalid config is rejected before any tool or effect is registered', () => {
  const { context, tools, effects } = createFakeContext();

  assert.throws(() => apply(context, { evaluation: { holdoutRatio: 0.9 } }), /ratios must sum to 1/);

  assert.deepEqual(tools, []);
  assert.deepEqual(effects, []);
});
