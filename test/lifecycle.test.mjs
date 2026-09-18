import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../dist/index.js';

test('apply registers embodied tools and disposes every registration', () => {
  const definitions = [];
  let dispose;
  const context = {
    tools: {
      register(definition) {
        definitions.push(definition);
        return () => {
          const index = definitions.indexOf(definition);
          if (index >= 0) definitions.splice(index, 1);
        };
      }
    },
    effect(setup) {
      dispose = setup();
      return { dispose };
    }
  };

  apply(context);
  assert.deepEqual(definitions.map((definition) => definition.name).sort(), [
    'embodied_act',
    'embodied_perceive',
    'embodied_query_state'
  ]);

  dispose();
  assert.equal(definitions.length, 0);
});