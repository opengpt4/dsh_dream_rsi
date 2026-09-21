import assert from 'node:assert/strict';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';

/**
 * The plugin mounted on a real Cordis context.
 *
 * `test/adapter-compat.test.mjs` drives `apply` with a hand-built object, which
 * is enough to test registration and disposal but never exercises the context
 * proxy that enforces `inject`. That is how an empty `inject` list shipped while
 * the plugin read the `tools` service: the fake context had a `tools` property,
 * so nothing complained.
 */

const TOOL_NAMES = ['dream_status', 'embodied_act', 'embodied_perceive', 'embodied_query_state'];

/** A `tools` service that rejects duplicates, so a second mount is observable. */
function toolsService(registered) {
  return {
    register(definition) {
      if (registered.includes(definition.name)) {
        throw new Error(`tool ${definition.name} already registered`);
      }
      registered.push(definition.name);
      return () => {
        const index = registered.indexOf(definition.name);
        if (index >= 0) registered.splice(index, 1);
      };
    }
  };
}

/** The default config would write `data/discovery.db`; keep the test off disk. */
const CONFIG = { storage: { sqlitePath: ':memory:' } };

async function loadModule() {
  return import('../dist/index.js');
}

test('the plugin mounts on a real Cordis context and registers its tools', async () => {
  const ctx = new Context();
  const registered = [];
  ctx.provide('tools', toolsService(registered));

  const fiber = await ctx.plugin(await loadModule(), CONFIG);

  assert.deepEqual([...registered].sort(), TOOL_NAMES);
  await fiber.dispose();
  assert.deepEqual(registered, []);
});

test('the plugin waits for the tools service rather than racing it', async () => {
  const ctx = new Context();
  const registered = [];

  // Start the mount with no service installed, give the fiber every chance to
  // activate, and only then provide it.
  const mounting = ctx.plugin(await loadModule(), CONFIG);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The fiber is held inactive, so nothing has been registered yet. Without
  // `inject` it would already have read `ctx.tools` and thrown.
  assert.deepEqual(registered, [], 'the plugin must not register before its service exists');

  ctx.provide('tools', toolsService(registered));
  const fiber = await mounting;

  assert.deepEqual([...registered].sort(), TOOL_NAMES);
  await fiber.dispose();
});

test('without the declaration the same mount fails on the proxy', async () => {
  const ctx = new Context();
  const registered = [];
  const module = await loadModule();

  // The negative case, and the reason `inject` is declared at all: an empty
  // list activates immediately and reads a service the store does not have.
  const undeclared = { ...module, inject: [] };
  const mounting = ctx.plugin(undeclared, CONFIG);
  await new Promise((resolve) => setTimeout(resolve, 20));
  ctx.provide('tools', toolsService(registered));

  await assert.rejects(
    async () => {
      await mounting;
    },
    /cannot get property "tools" without inject/
  );
  assert.deepEqual(registered, []);
});

test('a second mount onto the same context is refused and leaves the first intact', async () => {
  const ctx = new Context();
  const registered = [];
  ctx.provide('tools', toolsService(registered));
  const module = await loadModule();

  const first = await ctx.plugin(module, CONFIG);
  assert.deepEqual([...registered].sort(), TOOL_NAMES);

  await assert.rejects(async () => {
    await ctx.plugin(module, CONFIG);
  }, /already registered/);
  // The failed mount rolled back, so the first is untouched.
  assert.deepEqual([...registered].sort(), TOOL_NAMES);

  await first.dispose();
  assert.deepEqual(registered, []);
});

test('an invalid config fails the load before anything is registered', async () => {
  const ctx = new Context();
  const registered = [];
  ctx.provide('tools', toolsService(registered));

  const module = await loadModule();
  await assert.rejects(async () => {
    await ctx.plugin(module, { ...CONFIG, evaluation: { holdoutRatio: 0.9 } });
  }, /ratios must sum to 1/);
  assert.deepEqual(registered, []);
});

test('a disabled config mounts without registering anything', async () => {
  const ctx = new Context();
  const registered = [];
  ctx.provide('tools', toolsService(registered));

  const fiber = await ctx.plugin(await loadModule(), { ...CONFIG, enabled: false });

  assert.deepEqual(registered, []);
  await fiber.dispose();
});
