/**
 * Write into the DSH composer from the panel, as text or as a file attachment.
 *
 * The panel runs in a same-origin iframe, so the Host's page is reachable as
 * `window.parent`. Nothing here sends, submits or presses Enter: the text or the
 * attachment lands in the composer for the user to review and edit.
 *
 * Text insertion is attempted in this order, highest fidelity first, and every
 * miss logs why (`composer bridge: …`) so a field report names the layer that
 * failed:
 *
 *   1. element API — an `insertText` method exposed by the composer element
 *      itself (none today; checked so a future editor can take over);
 *   2. DOM paste   — synthetic `paste`, which is what Ctrl+V does and what the
 *      Lexical-based composer handles natively;
 *   3. DOM editing — `execCommand('insertText')` (or the textarea setter when
 *      the composer is a plain `<textarea>`);
 *   4. clipboard   — copy and tell the user to paste.
 *
 * Attachment insertion rides the composer's own PASTE_COMMAND: it reads
 * `clipboardData.items` of kind `file` and hands them to `intakeFiles`, which
 * uploads path-less files through the official upload route and renders a chip in
 * the composer rail. A JS-constructed `File` has no host path (`getPathForFile`
 * returns ""), so it takes exactly that upload branch.
 *
 * Two higher layers were investigated and are **not reachable from this realm**,
 * so they are deliberately absent rather than stubbed:
 *
 * - the `uiConversation` client service has no draft method (its surface is
 *   `binding` / `imageUrl` / `peekImageUrl` plus registries), and the panel has
 *   no cordis context anyway;
 * - the draft store is a `defineStore` *factory* mounted per session scope
 *   (`slots.register({ name: 'conversation.session', store })`); `create(scope)`
 *   returns a fresh instance, so writing through it would not re-render the
 *   composer. The same holds for attaching: `addAttachments(ids)` takes internal
 *   draft ids, and the mention path needs the editor's `insertFileReferences`.
 *
 * Selectors live in one place on purpose: DSH ships hashed CSS-module class
 * names, so only data attributes and ARIA roles are worth depending on.
 */

/** Composer candidates, most specific first. */
export const COMPOSER_SELECTORS = [
  // Stable marker the DSH composer itself carries (seen in its React props).
  '[data-composer-input]',
  // Lexical/ProseMirror style rich-text composer.
  '[role="textbox"][contenteditable="true"]',
  // Last resort: any visible editable, guarded by the checks in pickComposer.
  '[contenteditable="true"]',
];

/** Textarea composer candidates, used when the editor is a plain textarea. */
export const TEXTAREA_SELECTORS = ['textarea[data-composer-input]', 'textarea'];

const TEXTS = {
  zh: { marker: '> 来自 DeepSeek Chat', markerAt: '> 来自 DeepSeek Chat · 第 {n} 条' },
  en: { marker: '> From DeepSeek Chat', markerAt: '> From DeepSeek Chat · #{n}' },
};

/**
 * Prepend the source marker when the caller asks for it.
 *
 * `index` (1-based) appends the item number, which batch insert uses; leaving it
 * out keeps single-answer behaviour byte-for-byte identical.
 * @param {string} text Answer body.
 * @param {'zh'|'en'} lang Panel language.
 * @param {boolean} withMarker
 * @param {number} [index] 1-based position in a batch.
 */
export function withSourceMarker(text, lang = 'zh', withMarker = false, index) {
  if (!withMarker) return text;
  const base = (TEXTS[lang] ?? TEXTS.zh).marker;
  if (index === undefined) return `${base}\n\n${text}`;
  const numbered = (TEXTS[lang] ?? TEXTS.zh).markerAt.replace('{n}', String(index));
  return `${numbered}\n\n${text}`;
}

/** Hard limits for a batch: the UI asks before crossing them, never truncates. */
export const BATCH_LIMITS = {
  /** Above this, the user is asked whether to insert anyway. */
  maxAnswers: 8,
  /** Above this many characters, the user is asked whether to insert anyway. */
  maxChars: 20_000,
  /** Separator between two answers. */
  separator: '\n\n---\n\n',
};

/**
 * Join several answers into one insertable document.
 *
 * Ordering is by `at` (a sortable timestamp or index), so a caller that passes a
 * Set or a map-ordered list still produces chronological text. Nothing is
 * truncated: when the batch crosses a limit the result says so and the caller
 * decides.
 *
 * @param {Array<{text: string, at?: number}>} answers
 * @param {object} [options]
 * @param {'zh'|'en'} [options.lang]
 * @param {boolean} [options.marker] Prefix each answer with its source line.
 * @returns {{text: string, count: number, chars: number, overLimit: boolean, reasons: string[]}}
 */
export function joinAnswers(answers, options = {}) {
  const list = (Array.isArray(answers) ? answers : [])
    .filter((answer) => answer !== null && answer !== undefined)
    .map((answer, order) => ({
      text: String(answer.text ?? ''),
      at: Number.isFinite(answer.at) ? answer.at : order,
      order,
    }))
    .sort((left, right) => left.at - right.at || left.order - right.order);

  const parts = list.map((answer, index) =>
    withSourceMarker(answer.text, options.lang ?? 'zh', options.marker === true, index + 1),
  );
  const text = parts.join(BATCH_LIMITS.separator);

  const reasons = [];
  if (list.length > BATCH_LIMITS.maxAnswers) reasons.push('count');
  if (text.length > BATCH_LIMITS.maxChars) reasons.push('chars');

  return {
    text,
    count: list.length,
    chars: text.length,
    overLimit: reasons.length > 0,
    reasons,
  };
}

/**
 * Compose what actually gets inserted: a blank line first when the composer
 * already holds text, so the answer never glues itself onto the draft.
 * @param {string} text Body to insert.
 * @param {string} existing Current composer text.
 */
export function buildPayload(text, existing) {
  return existing.trim().length === 0 ? text : `\n\n${text}`;
}

/**
 * Resolve the page that owns the composer.
 *
 * The panel is a same-origin iframe inside the DSH window; a standalone panel
 * (preview harness, direct tab) falls back to its own window.
 * @param {Window} win Panel window.
 */
export function hostWindow(win) {
  try {
    const parent = win.parent;
    if (parent !== undefined && parent !== null && parent !== win && parent.document !== undefined) return parent;
  } catch (error) {
    // Cross-origin host: nothing we can do from here.
    console.warn(`composer bridge: host window unreachable (${String(error?.message ?? error)})`);
  }
  return win;
}

/**
 * Find the composer element in a document.
 * @param {Document} doc
 * @returns {HTMLElement | null}
 */
export function pickComposer(doc) {
  for (const selector of COMPOSER_SELECTORS) {
    for (const element of doc.querySelectorAll(selector)) {
      if (!isUsable(element)) continue;
      if (element.getAttribute('contenteditable') === 'false') continue;
      return element;
    }
  }
  for (const selector of TEXTAREA_SELECTORS) {
    for (const element of doc.querySelectorAll(selector)) {
      if (isUsable(element)) return element;
    }
  }
  return null;
}

/** @param {Element} element */
function isUsable(element) {
  if (element === null || element === undefined) return false;
  if (element.disabled === true || element.readOnly === true) return false;
  if (element.getAttribute?.('aria-disabled') === 'true') return false;
  if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
  return true;
}

/** Let the editor settle before verifying an insertion. */
function settle(win) {
  return new Promise((resolve) => {
    const raf = win.requestAnimationFrame;
    if (typeof raf === 'function') raf(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
}

/**
 * Read the composer's current text.
 * @param {HTMLElement} element
 */
function readText(element) {
  if (element.tagName === 'TEXTAREA') return String(element.value ?? '');
  return String(element.textContent ?? '');
}

/** Put the caret after the last character so pasted text lands at the end. */
function caretToEnd(doc, element) {
  try {
    const selection = doc.getSelection?.();
    if (selection === null || selection === undefined) return;
    const range = doc.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch (error) {
    console.warn(`composer bridge: could not move the caret (${String(error?.message ?? error)})`);
  }
}

/** Attempt 0: an editor-provided insert method, if a future DSH exposes one. */
function tryElementApi(element, payload) {
  if (typeof element.insertText !== 'function') return false;
  try {
    element.insertText(payload);
    return true;
  } catch (error) {
    console.warn(`composer bridge: element insertText failed (${String(error?.message ?? error)})`);
    return false;
  }
}

/** Attempt 3a: a synthetic paste, which is exactly what Ctrl+V does and what the
 * Lexical-based composer handles natively. */
function tryPaste(win, doc, element, payload) {
  const DataTransferCtor = win.DataTransfer;
  const ClipboardEventCtor = win.ClipboardEvent;  if (typeof DataTransferCtor !== 'function' || typeof ClipboardEventCtor !== 'function') {
    console.warn('composer bridge: DataTransfer/ClipboardEvent unavailable, skipping the paste layer');
    return false;
  }
  try {
    const data = new DataTransferCtor();
    data.setData('text/plain', payload);
    const event = new ClipboardEventCtor('paste', { clipboardData: data, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return true;
  } catch (error) {
    console.warn(`composer bridge: paste dispatch failed (${String(error?.message ?? error)})`);
    return false;
  }
}

/** Attempt 3b: insertText through the document's editing command. */
function tryInsertText(doc, element, payload) {
  if (typeof doc.execCommand !== 'function') {
    console.warn('composer bridge: execCommand unavailable, skipping insertText');
    return false;
  }
  caretToEnd(doc, element);
  try {
    return doc.execCommand('insertText', false, payload) !== false;
  } catch (error) {
    console.warn(`composer bridge: insertText failed (${String(error?.message ?? error)})`);
    return false;
  }
}

/** Attempt 3c: a plain textarea, written through the prototype setter. */
function tryTextarea(win, element, payload) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value');
    if (descriptor?.set === undefined) {
      console.warn('composer bridge: no native textarea value setter found');
      return false;
    }
    descriptor.set.call(element, `${element.value}${payload}`);
    element.dispatchEvent(new win.Event('input', { bubbles: true }));
    return true;
  } catch (error) {
    console.warn(`composer bridge: textarea write failed (${String(error?.message ?? error)})`);
    return false;
  }
}

/** @param {HTMLElement} element @param {string} before @param {string} payload */
function changed(element, before, payload) {
  const after = readText(element);
  if (after === before) return false;
  const probe = payload.trim().slice(0, 24);
  return probe.length === 0 || after.includes(probe);
}

/**
 * Insert text into the DSH composer.
 *
 * @param {string} text Plain-text markdown to insert (no rich text conversion).
 * @param {object} [options]
 * @param {Window} [options.window] Panel window, injectable for tests.
 * @param {boolean} [options.marker] Prefix a source line.
 * @param {'zh'|'en'} [options.lang] Language for that line.
 * @param {(message: string) => void} [options.warn] Warning sink (default console.warn).
 * @returns {Promise<{ok: boolean, via: 'element'|'paste'|'insertText'|'textarea'|'clipboard'|'none', reason?: string, text: string}>}
 */
export async function insertIntoComposer(text, options = {}) {
  const win = options.window ?? globalThis.window;
  const warn = typeof options.warn === 'function' ? options.warn : (message) => console.warn(message);
  const body = withSourceMarker(String(text ?? ''), options.lang ?? 'zh', options.marker === true);
  if (body.trim().length === 0) return { ok: false, via: 'none', reason: 'empty', text: body };
  if (win === undefined || win === null) return { ok: false, via: 'none', reason: 'no-window', text: body };

  const host = hostWindow(win);
  const doc = host.document;
  const element = pickComposer(doc);

  if (element === null) {
    // Layer 3 has no target; fall through to the clipboard so the user still
    // gets the text with one keystroke.
    warn('composer bridge: composer not found, falling back to the clipboard');
    return copyToClipboard(win, body, 'composer-not-found');
  }

  const before = readText(element);
  const payload = buildPayload(body, before);

  // Focus first: every editing path needs the composer to own the caret.
  try {
    element.focus();
  } catch (error) {
    warn(`composer bridge: focus failed (${String(error?.message ?? error)})`);
  }
  const focused = doc.activeElement === element || element.contains?.(doc.activeElement) === true;
  if (!focused) {
    warn('composer bridge: the composer did not take focus (a modal or focus trap may be open)');
  }
  await settle(host);

  if (element.tagName === 'TEXTAREA') {
    if (tryTextarea(win, element, payload) && changed(element, before, payload)) {
      element.focus();
      return { ok: true, via: 'textarea', text: payload };
    }
    warn('composer bridge: textarea layer did not change the value, falling back to the clipboard');
    return copyToClipboard(win, body, 'textarea-failed');
  }

  if (tryElementApi(element, payload)) {
    await settle(host);
    if (changed(element, before, payload)) {
      element.focus();
      return { ok: true, via: 'element', text: payload };
    }
    warn('composer bridge: element insertText changed nothing, trying the paste layer');
  }

  if (tryPaste(host, doc, element, payload)) {
    await settle(host);
    if (changed(element, before, payload)) {
      element.focus();
      return { ok: true, via: 'paste', text: payload };
    }
    warn('composer bridge: paste dispatched but the editor kept its text, trying insertText');
  }

  if (tryInsertText(doc, element, payload)) {
    await settle(host);
    if (changed(element, before, payload)) {
      element.focus();
      return { ok: true, via: 'insertText', text: payload };
    }
    warn('composer bridge: insertText returned success but the text did not change');
  }

  warn('composer bridge: DOM layers failed, falling back to the clipboard');
  return copyToClipboard(win, body, 'dom-failed');
}

/**
 * Last resort: put the answer on the clipboard.
 * @param {Window} win @param {string} text @param {string} reason
 */
async function copyToClipboard(win, text, reason) {
  try {
    const clipboard = win.navigator?.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
      console.warn('composer bridge: clipboard API unavailable');
      return { ok: false, via: 'clipboard', reason: `${reason}:no-clipboard`, text };
    }
    await clipboard.writeText(text);
    return { ok: false, via: 'clipboard', reason, text };
  } catch (error) {
    console.warn(`composer bridge: clipboard write failed (${String(error?.message ?? error)})`);
    return { ok: false, via: 'clipboard', reason: `${reason}:write-failed`, text };
  }
}

/** Attachment chips carry the display name; this is how a chip is recognised. */
export const ATTACHMENT_TIMEOUT_MS = 2500;

/**
 * Name one answer file. Unique per call so a chip can be found by text, and
 * deterministic per message so the same answer reuses its name.
 * @param {string} [id] Message id or index.
 * @param {number} [stamp] Extra discriminator when no id exists.
 */
export function attachmentName(id, stamp = Date.now()) {
  const safe = String(id ?? '')
    .replace(/[^\w-]+/gu, '')
    .slice(0, 24);
  return `answer-${safe.length > 0 ? safe : String(stamp)}.md`;
}

/**
 * Find a freshly created chip that names this attachment.
 *
 * DSH renders the rail with hashed CSS-module class names, so the display name is
 * the only stable signal; it is searched inside the composer's own container.
 * @param {Document} doc
 * @param {string} name
 */
export function findAttachmentChip(doc, name) {
  for (const node of doc.querySelectorAll('*')) {
    if (node.children.length > 0) continue;
    const text = node.textContent ?? '';
    if (!text.includes(name)) continue;
    const title = node.getAttribute?.('title') ?? '';
    const label = node.getAttribute?.('aria-label') ?? '';
    if (title.includes(name) || label.includes(name) || text.includes(name)) return node;
  }
  return null;
}

/**
 * Insert the answer as a file attachment chip.
 *
 * A JS-built `File` has no host path, so the composer's PASTE_COMMAND hands it to
 * `intakeFiles`, which uploads through the official route and renders a chip. The
 * upload keeps the bytes in DSH's own attachment store; this plugin writes no
 * file of its own, so there is nothing for it to prune later.
 *
 * @param {string} text Markdown to attach.
 * @param {object} [options]
 * @param {Window} [options.window] Panel window, injectable for tests.
 * @param {string} [options.name] File name; defaults to `answer-<id>.md`.
 * @param {string} [options.id] Message id used in the default name.
 * @param {'zh'|'en'} [options.lang] Language for the optional source line.
 * @param {boolean} [options.marker] Prefix the source line inside the file.
 * @param {(message: string) => void} [options.warn] Warning sink.
 * @returns {Promise<{ok: boolean, via: 'attachment'|'none', reason?: string, text: string, name: string}>}
 */
export async function insertAsAttachment(text, options = {}) {
  const win = options.window ?? globalThis.window;
  const warn = typeof options.warn === 'function' ? options.warn : (message) => console.warn(message);
  const body = withSourceMarker(String(text ?? ''), options.lang ?? 'zh', options.marker === true);
  const name = options.name ?? attachmentName(options.id);
  if (body.trim().length === 0) return { ok: false, via: 'none', reason: 'empty', text: body, name };
  if (win === undefined || win === null) return { ok: false, via: 'none', reason: 'no-window', text: body, name };

  const host = hostWindow(win);
  const doc = host.document;
  const element = pickComposer(doc);
  if (element === null) {
    warn('composer bridge: composer not found, cannot attach a file');
    return { ok: false, via: 'none', reason: 'composer-not-found', text: body, name };
  }

  const FileCtor = host.File;
  const DataTransferCtor = host.DataTransfer;
  const ClipboardEventCtor = host.ClipboardEvent;
  if (typeof FileCtor !== 'function' || typeof DataTransferCtor !== 'function' || typeof ClipboardEventCtor !== 'function') {
    warn('composer bridge: File/DataTransfer/ClipboardEvent unavailable, cannot attach a file');
    return { ok: false, via: 'none', reason: 'no-file-api', text: body, name };
  }

  try {
    element.focus();
  } catch (error) {
    warn(`composer bridge: focus failed (${String(error?.message ?? error)})`);
  }
  await settle(host);

  let event;
  try {
    const file = new FileCtor([body], name, { type: 'text/markdown' });
    const data = new DataTransferCtor();
    data.items.add(file);
    event = new ClipboardEventCtor('paste', { clipboardData: data, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
  } catch (error) {
    warn(`composer bridge: attachment paste failed (${String(error?.message ?? error)})`);
    return { ok: false, via: 'none', reason: 'paste-failed', text: body, name };
  }

  const chip = await waitForChip(host, name, options.timeoutMs ?? ATTACHMENT_TIMEOUT_MS);
  if (chip === null) {
    warn(`composer bridge: the composer accepted the paste but rendered no chip for ${name}`);
    return { ok: false, via: 'none', reason: 'no-chip', text: body, name };
  }
  return { ok: true, via: 'attachment', text: body, name };
}

/**
 * Wait for a chip naming this file; the rail renders after the paste round-trip.
 * @param {Window} host @param {string} name @param {number} timeoutMs
 */
async function waitForChip(host, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chip = findAttachmentChip(host.document, name);
    if (chip !== null) return chip;
    await new Promise((resolve) => {
      const raf = host.requestAnimationFrame;
      if (typeof raf === 'function') raf(() => setTimeout(resolve, 60));
      else setTimeout(resolve, 60);
    });
  }
  return findAttachmentChip(host.document, name);
}
