/**
 * Unit checks for the composer bridge.
 *
 * A fake window/document stands in for the DSH page: enough DOM surface for the
 * bridge's feature detection, and editors whose text only changes when the
 * mechanism under test actually runs. Each tier of the fallback chain is
 * therefore exercised on its own.
 *
 * Run: node scripts/composer-bridge-check.mjs
 */
import assert from 'node:assert/strict';
import {
  buildPayload,
  insertIntoComposer,
  pickComposer,
  withSourceMarker,
} from '../lib/web/composer-bridge.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

/**
 * Fake window whose document exposes one composer candidate.
 * @param {object} options
 * @param {'none'|'supported'} [options.execCommand] Whether insertText works.
 * @param {{writeText: (text: string) => Promise<void>}} [options.clipboard]
 */
function makeWindow({ execCommand = 'none', clipboard } = {}) {
  const state = { element: null };

  const doc = {
    activeElement: null,
    querySelectorAll(selector) {
      const element = state.element;
      if (element === null) return [];
      if (selector === '[data-composer-input]') return element.isComposer === true ? [element] : [];
      if (selector === '[role="textbox"][contenteditable="true"]') return element.isComposer === true ? [element] : [];
      if (selector === '[contenteditable="true"]') return element.tagName === 'TEXTAREA' ? [] : [element];
      if (selector === 'textarea[data-composer-input]') {
        return element.tagName === 'TEXTAREA' && element.isComposer === true ? [element] : [];
      }
      if (selector === 'textarea') return element.tagName === 'TEXTAREA' ? [element] : [];
      return [];
    },
    getSelection() {
      return { removeAllRanges() {}, addRange() {} };
    },
    createRange() {
      return { selectNodeContents() {}, collapse() {} };
    },
    execCommand(name, _show, text) {
      if (name !== 'insertText' || execCommand !== 'supported') return false;
      state.element.textContent += text;
      return true;
    },
  };

  class FakeClipboardEvent {
    constructor(type, init) {
      this.type = type;
      this.clipboardData = init.clipboardData;
      this.bubbles = init.bubbles;
      this.cancelable = init.cancelable;
      this.defaultPrevented = false;
      this.isTrusted = false;
    }
  }
  class FakeDataTransfer {
    constructor() {
      this.data = new Map();
    }
    setData(type, value) {
      this.data.set(type, value);
    }
    getData(type) {
      return this.data.get(type) ?? '';
    }
  }
  class FakeEvent {
    constructor(type) {
      this.type = type;
      this.bubbles = true;
    }
  }

  const win = {
    document: doc,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent,
    Event: FakeEvent,
    HTMLTextAreaElement: { prototype: {} },
    requestAnimationFrame(callback) {
      callback(0);
    },
    navigator: { clipboard },
    setComposer(element) {
      state.element = element;
    },
  };
  win.parent = win;
  return win;
}

/**
 * Fake composer. `editor` decides which mechanism can change its text.
 * @param {ReturnType<typeof makeWindow>} win
 * @param {{tagName?: string, editor?: 'none'|'paste'|'insertText', text?: string}} options
 */
function makeElement(win, { tagName = 'DIV', editor = 'none', text = '' } = {}) {
  const listeners = new Map();
  const element = {
    tagName,
    textContent: text,
    value: text,
    disabled: false,
    readOnly: false,
    isComposer: true,
    getAttribute(name) {
      if (name === 'aria-disabled') return null;
      if (name === 'contenteditable') return tagName === 'TEXTAREA' ? null : 'true';
      return null;
    },
    getClientRects() {
      return [{ width: 600, height: 40 }];
    },
    contains(node) {
      return node === element;
    },
    focus() {
      element.focused = true;
      win.document.activeElement = element;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatchEvent(event) {
      const handler = listeners.get(event.type);
      if (handler !== undefined) handler(event);
      if (event.type === 'paste') {
        if (editor === 'paste') {
          element.textContent += event.clipboardData.getData('text/plain');
          event.defaultPrevented = true;
        }
        return true;
      }
      if (event.type === 'input') element.textContent = element.value;
      return true;
    },
  };
  win.setComposer(element);
  return element;
}

await check('payload gets a blank line only when the composer has text', async () => {
  assert.equal(buildPayload('answer', ''), 'answer');
  assert.equal(buildPayload('answer', '   '), 'answer');
  assert.equal(buildPayload('answer', 'draft'), '\n\nanswer');
});

await check('source marker is off by default and bilingual', async () => {
  assert.equal(withSourceMarker('answer', 'zh', false), 'answer');
  assert.equal(withSourceMarker('answer', 'zh', true), '> 来自 DeepSeek Chat\n\nanswer');
  assert.equal(withSourceMarker('answer', 'en', true), '> From DeepSeek Chat\n\nanswer');
});

await check('composer is found through the data marker, not a hashed class', async () => {
  const win = makeWindow();
  const element = makeElement(win, { editor: 'paste' });
  assert.equal(pickComposer(win.document), element);
});

await check('a synthetic paste inserts the answer and leaves focus on the composer', async () => {
  const win = makeWindow();
  const element = makeElement(win, { editor: 'paste', text: 'draft' });
  const result = await insertIntoComposer('answer', { window: win });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'paste');
  assert.equal(element.textContent, 'draft\n\nanswer');
  assert.equal(win.document.activeElement, element);
});

await check('paste the editor ignores falls through to insertText', async () => {
  const win = makeWindow({ execCommand: 'supported' });
  const element = makeElement(win, { editor: 'insertText', text: '' });
  const result = await insertIntoComposer('answer', { window: win });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'insertText');
  assert.equal(element.textContent, 'answer');
});

await check('a plain textarea is written through the prototype setter', async () => {
  const win = makeWindow();
  const element = makeElement(win, { tagName: 'TEXTAREA', text: '' });
  Object.defineProperty(win.HTMLTextAreaElement.prototype, 'value', {
    configurable: true,
    set(next) {
      element.value = next;
      element.textContent = next;
    },
  });
  const result = await insertIntoComposer('answer', { window: win });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'textarea');
  assert.equal(element.value, 'answer');
});

await check('no composer at all copies the answer to the clipboard', async () => {
  const writes = [];
  const win = makeWindow({ clipboard: { writeText: async (text) => writes.push(text) } });
  const result = await insertIntoComposer('answer', { window: win });
  assert.equal(result.ok, false);
  assert.equal(result.via, 'clipboard');
  assert.equal(result.reason, 'composer-not-found');
  assert.deepEqual(writes, ['answer']);
});

await check('DOM failure also lands on the clipboard, and a broken clipboard reports it', async () => {
  const writes = [];
  const stubbornWin = makeWindow({ clipboard: { writeText: async (text) => writes.push(text) } });
  makeElement(stubbornWin, { editor: 'none', text: '' });
  const failed = await insertIntoComposer('answer', { window: stubbornWin });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'dom-failed');
  assert.deepEqual(writes, ['answer']);

  const angryWin = makeWindow({
    clipboard: {
      writeText: async () => {
        throw new Error('denied');
      },
    },
  });
  makeElement(angryWin, { editor: 'none', text: '' });
  const broken = await insertIntoComposer('answer', { window: angryWin });
  assert.equal(broken.ok, false);
  assert.match(String(broken.reason), /dom-failed:write-failed/u);
});

await check('empty text is rejected before touching the page', async () => {
  const win = makeWindow();
  const element = makeElement(win, { editor: 'paste', text: '' });
  const result = await insertIntoComposer('   ', { window: win });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
  assert.equal(element.textContent, '');
});

console.log(failures === 0 ? '\ncomposer bridge checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
