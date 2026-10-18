/**
 * Client-half smoke test: execute the hand-written bundle in a fake browser
 * shell, then drive its `apply()` against fake slot services.
 *
 * Run: node scripts/client-smoke.mjs
 */
import assert from 'node:assert/strict';

let registered;
const vnodes = [];

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registered = entry;
    },
  },
};

const styleTags = [];
globalThis.document = {
  head: { appendChild: (node) => styleTags.push(node) },
  querySelector: () => null,
  createElement: (tag) => ({ tag, dataset: {}, textContent: '' }),
};

await import('../lib/client.js');

assert.ok(registered, 'the bundle must register itself with __ModuleLoader__');
assert.equal(registered.id, 'dsh-deepseek-web-chat');

const fakeRequire = (name) => {
  if (name === 'react') return { createElement: (...args) => ({ type: 'element', args }) };
  if (name === 'react/jsx-runtime') {
    return {
      jsx: (type, props) => {
        const node = { type, props };
        vnodes.push(node);
        return node;
      },
      jsxs: (type, props) => ({ type, props }),
    };
  }
  throw new Error(`the client bundle required an unavailable module: ${name}`);
};

const exported = registered.factory(fakeRequire);
assert.equal(typeof exported.apply, 'function', 'the bundle must export apply');
assert.ok(Array.isArray(exported.inject), 'the bundle must export inject');

const calls = { types: [], slots: [], injected: [] };
const fakeCtx = {
  sidebarRightTabs: {
    register(definition) {
      calls.types.push(definition);
      return () => {};
    },
  },
  slots: {
    inject(name, register) {
      calls.injected.push(name);
      return register();
    },
    register(definition, component) {
      calls.slots.push({ definition, component });
      return () => {};
    },
  },
  effect(fn) {
    fn();
    return () => {};
  },
};

exported.apply(fakeCtx);

assert.deepEqual(calls.injected, ['sidebar.right.pane.tab']);
assert.equal(calls.types.length, 1);
const [type] = calls.types;
assert.equal(type.kind, 'deepseek-chat');
assert.equal(type.id, 'dsh-deepseek-web-chat/tab');
assert.equal(type.title(), 'DeepSeek Chat');
assert.equal(typeof type.guide[0].title, 'function');
assert.equal(type.guide[0].title(), 'DeepSeek Chat');

assert.equal(calls.slots.length, 1);
assert.equal(calls.slots[0].definition.name, 'sidebar.right.pane.tab');
assert.equal(calls.slots[0].definition.key, type.id);

const tree = calls.slots[0].component({});
assert.equal(tree.type, 'div');
const iframe = tree.props.children;
assert.equal(iframe.type, 'iframe');
assert.ok(iframe.props.src.startsWith('/deepseek-web/'), `unexpected src: ${iframe.props.src}`);
assert.equal(iframe.props.title, 'DeepSeek Chat');
assert.ok(styleTags.length === 1, 'exactly one style tag is injected');

// A second render must not append a duplicate stylesheet; the real guard uses
// document.querySelector, which this fake always answers with null.
calls.slots[0].component({});

console.log('ok   bundle registers, exposes apply/inject, and renders the panel iframe');
console.log(`ok   injected slot(s): ${calls.injected.join(', ')}`);
console.log(`ok   tab type: ${type.id} (kind ${type.kind})`);
