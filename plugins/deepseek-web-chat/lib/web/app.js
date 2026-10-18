/**
 * DeepSeek Chat side panel — browser half.
 *
 * Served by the host plugin at /deepseek-web/ and rendered inside a DSH
 * sidebar iframe. Plain DOM, no build step, no third-party code.
 */
/**
 * All data calls hang off `/deepseek-web/api/`. Resolving the directory once
 * keeps that path correct regardless of the panel's trailing slash or query; stripping it and appending "api/…" produced /deepseek-webapi/…
 * which the router answered with 404 (GET) and 405 (POST).
 */
const API_BASE = new URL('api/', window.location.href).href;

/**
 * Surface a broken script instead of leaving an empty panel: a fatal error is
 * shown in place and recorded on `<body data-panel-error>` for diagnosis.
 */
function reportFatal(message) {
  if (document.body?.dataset.panelError === message) return;
  if (document.body) document.body.dataset.panelError = message;
  const banner = document.createElement('div');
  banner.className = 'fatal';
  banner.textContent = ui('panelError', { message });
  document.body?.append(banner);
}
window.addEventListener('error', (event) => reportFatal(event.message || 'unknown error'));
window.addEventListener('unhandledrejection', (event) => reportFatal(String(event.reason?.message ?? event.reason)));

const state = {
  signedIn: false,
  user: null,
  dshAccount: null,
  sameAccount: false,
  workspace: { root: '', name: '' },
  settings: {},
  sessions: [],
  sessionId: null,
  messages: [],
  context: [],
  thinking: false,
  search: false,
  streaming: false,
  pickerPath: '',
  pickerSelection: new Set(),
  lang: initialLang(),
  /** Multi-select mode over finished answers; `selected` holds message indexes. */
  selecting: false,
  selected: new Set(),
};

const el = {
  account: document.getElementById('account'),
  who: document.getElementById('account-who'),
  signIn: document.getElementById('sign-in'),
  signOut: document.getElementById('sign-out'),
  newChat: document.getElementById('new-chat'),
  history: document.getElementById('history'),
  transcript: document.getElementById('transcript'),
  empty: document.getElementById('empty'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  chips: document.getElementById('chips'),
  attach: document.getElementById('attach'),
  pickSession: document.getElementById('pick-session'),
  note: document.getElementById('note'),
  emptyHint: document.getElementById('empty-hint'),
  thinking: document.getElementById('toggle-thinking'),
  search: document.getElementById('toggle-search'),
  modal: document.getElementById('modal-backdrop'),
  modalTitle: document.getElementById('modal-title'),
  modalBody: document.getElementById('modal-body'),
  modalFoot: document.getElementById('modal-foot'),
  drop: document.getElementById('drop-overlay'),
  toast: document.getElementById('toast'),
  selectBar: document.getElementById('select-bar'),
  selectCount: document.getElementById('select-count'),
  selectInsert: document.getElementById('select-insert'),
  selectCopy: document.getElementById('select-copy'),
  selectCancel: document.getElementById('select-cancel'),
  langToggle: document.getElementById('lang-toggle'),
  emptyTitle: document.getElementById('empty-title'),
  emptyTagline: document.getElementById('empty-tagline'),
};

/**
 * The pre-login gate and the message actions share one bilingual copy module.
 *
 * Before sign-in the panel shows nothing but this screen: the transcript, the
 * composer and the context rails stay out of reach until a credential exists.
 */
import { GATE_COPY, PANEL_COPY, UI_COPY } from './gate-copy.js';
// Aliased: this module already has a local `insertIntoComposer` that writes into
// the panel's own textarea (the drag-and-drop fallback), which is a different
// destination from the DSH composer.
import { insertIntoComposer as insertIntoHostComposer, insertAsAttachment, joinAnswers } from './composer-bridge.js';

/** Current gate language; persisted so it survives a reload. */
function initialLang() {
  try {
    const stored = window.localStorage.getItem('dsw-chat-lang');
    if (stored === 'zh' || stored === 'en') return stored;
  } catch {
    /* storage may be unavailable */
  }
  return 'zh';
}

/** Gate element handles, resolved once. */
const gate = {
  root: document.getElementById('gate'),
  title: document.getElementById('gate-title'),
  subtitle: document.getElementById('gate-subtitle'),
  steps: document.getElementById('gate-steps'),
  submit: document.getElementById('gate-submit'),
  browser: document.getElementById('gate-browser'),
  token: document.getElementById('gate-token'),
  status: document.getElementById('gate-status'),
  privacy: document.getElementById('gate-privacy'),
  langZh: document.getElementById('gate-lang-zh'),
  langEn: document.getElementById('gate-lang-en'),
};

/** Copy for the active language. */
function t(key) {
  return (GATE_COPY[state.lang] ?? GATE_COPY.zh)[key] ?? key;
}

/** Copy for the message action row, in the active language. */
function p(key) {
  return (PANEL_COPY[state.lang] ?? PANEL_COPY.zh)[key] ?? key;
}

/**
 * Panel chrome copy: everything the language toggle flips.
 * @param {string} key
 * @param {Record<string, string|number>} [values]
 */
function ui(key, values) {
  const table = UI_COPY[state.lang] ?? UI_COPY.zh;
  const text = table[key] ?? UI_COPY.zh[key] ?? key;
  return values === undefined
    ? text
    : Object.entries(values).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), text);
}

/**
 * Copy with substitutions, e.g. `pf('selectedCount', { n: 3 })`.
 * @param {string} key
 * @param {Record<string, string|number>} values
 */
function pf(key, values) {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    p(key),
  );
}

/** Build the illustrated four-step guide (thumbnails zoom into a modal). */
function renderGateSteps() {
  const copy = (GATE_COPY[state.lang] ?? GATE_COPY.zh).steps;
  gate.steps.replaceChildren(
    ...copy.map(([title, caption], index) => {
      const step = index + 1;
      const image = h('img', {
        src: `guide/step${step}.svg`,
        alt: `${step}. ${title}`,
        loading: 'lazy',
        title: t('zoom'),
        onclick: () =>
          openModal({
            title: `${step}. ${title}`,
            body: [h('img', { class: 'zoom-img', src: `guide/step${step}.svg`, alt: title })],
            footer: [h('button', { text: ui('close'), onclick: closeModal })],
          }),
      });
      return h(
        'li',
        { class: 'gate-step' },
        h('div', { class: 'gate-step-thumb' }, image),
        h('div', { class: 'gate-step-text' }, h('b', { text: `${step}. ${title}` }), h('span', { text: caption })),
      );
    }),
  );
}

/** Translate every gate label and reflect the language buttons. */
function renderGate() {
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
  gate.title.textContent = t('title');
  gate.subtitle.textContent = t('subtitle');
  gate.submit.textContent = t('submit');
  gate.browser.textContent = t('openSite');
  gate.token.placeholder = t('tokenLabel');
  gate.privacy.textContent = t('privacy');
  renderGateSteps();
  gate.langZh.setAttribute('aria-pressed', String(state.lang === 'zh'));
  gate.langEn.setAttribute('aria-pressed', String(state.lang === 'en'));
  // The visual state is a class: attribute selectors alone left the highlight on
  // the wrong button in the packaged build.
  gate.langZh.classList.toggle('is-active', state.lang === 'zh');
  gate.langEn.classList.toggle('is-active', state.lang === 'en');
}

/** Show the gate (pre-login) or the chat surface. */
function showGate(visible) {
  if (gate.root === null) return;
  gate.root.hidden = !visible;
  document.body.dataset.gate = visible ? 'on' : 'off';
  if (visible) {
    renderGate();
    // The token box is the only sign-in input; guard anyway so a markup change
    // cannot turn the whole panel into a fatal-error banner.
    gate.token?.focus();
  }
}

/**
 * Accept the several shapes a pasted token arrives in: the raw value, a quoted
 * string, `userToken: …`, or the whole `{"value":"…","__version":"0"}` object
 * that DevTools shows when the storage entry is inspected.
 * @param {string} raw Whatever the user pasted.
 * @returns {string} The token alone, or an empty string.
 */
function parsePastedToken(raw) {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return '';
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.value === 'string') return parsed.value.trim();
  } catch {
    /* not JSON, keep going */
  }
  const labelled = /\bvalue\b\s*[:=]\s*["']?([^"',}\s]+)/iu.exec(text);
  if (labelled !== null) return labelled[1];
  return text.replace(/^["']|["']$/gu, '').split(/\s+/u)[0];
}

/* ------------------------------------------------------------------ utils */

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

async function request(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Unexpected response (HTTP ${response.status})`);
  }
  if (!response.ok || payload.ok === false) {
    // The Host clears a rejected credential; mirror that here so the panel drops
    // its signed-in look and offers the dialog instead of failing every call.
    if (payload.signedOut === true && state.signedIn) {
      state.signedIn = false;
      state.user = null;
      renderAccount();
    }
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

function formatRelative(seconds) {
  if (!seconds) return '';
  const delta = Date.now() / 1000 - seconds;
  if (delta < 60) return ui('justNow');
  if (delta < 3600) return ui('minutesAgo', { n: Math.floor(delta / 60) });
  if (delta < 86400) return ui('hoursAgo', { n: Math.floor(delta / 3600) });
  return ui('daysAgo', { n: Math.floor(delta / 86400) });
}

/* -------------------------------------------------------- text rendering */

/**
 * Render model text with the tiny subset that matters in a chat panel:
 * fenced code blocks, inline code, bold, and headings. Everything is created
 * as DOM text nodes — model output never reaches innerHTML.
 */
function renderRichText(text, sources = []) {
  const wrapper = document.createDocumentFragment();
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match;
  while ((match = fence.exec(text)) !== null) {
    appendInline(wrapper, text.slice(cursor, match.index), sources);
    const language = match[1].trim();
    const code = h('pre', { class: 'chunk' }, h('code', { text: match[2].replace(/\n$/, '') }));
    if (language) code.dataset.language = language;
    wrapper.append(code);
    cursor = match.index + match[0].length;
  }
  appendInline(wrapper, text.slice(cursor), sources);
  return wrapper;
}

/**
 * Render one non-code run, line by line: headings become strong text and list
 * markers become bullets, while inline code, bold and `[citation:N]` links keep
 * their own tokens. Everything stays a DOM text node — no innerHTML.
 */
function appendInline(wrapper, text, sources = []) {
  if (text.length === 0) return;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) wrapper.append(document.createTextNode('\n'));
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      wrapper.append(h('strong', { class: 'md-heading', text: heading[1] }));
      return;
    }
    const bullet = /^\s*[*-]\s+(.*)$/.exec(line);
    appendInlineTokens(wrapper, bullet === null ? line : `• ${bullet[1]}`, sources);
  });
}

function appendInlineTokens(wrapper, text, sources) {
  if (text.length === 0) return;
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[citation:(\d+)\])/g;
  let cursor = 0;
  let match;
  while ((match = token.exec(text)) !== null) {
    if (match.index > cursor) wrapper.append(document.createTextNode(text.slice(cursor, match.index)));
    const piece = match[0];
    if (piece.startsWith('`')) wrapper.append(h('code', { class: 'inline', text: piece.slice(1, -1) }));
    else if (piece.startsWith('**')) wrapper.append(h('strong', { text: piece.slice(2, -2) }));
    else {
      const index = Number(match[2]);
      const source = sources[index - 1];
      if (source?.url) {
        wrapper.append(
          h('a', {
            class: 'citation',
            href: source.url,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: source.title || source.url,
            text: String(index),
          }),
        );
      } else {
        wrapper.append(document.createTextNode(piece));
      }
    }
    cursor = match.index + piece.length;
  }
  if (cursor < text.length) wrapper.append(document.createTextNode(text.slice(cursor)));
}

/* -------------------------------------------------------------- rendering */

function renderAccount() {
  // Signed out means the gate is the whole panel: no transcript, no composer.
  showGate(!state.signedIn);
  el.account.classList.toggle('signed-in', state.signedIn);
  el.who.textContent = state.signedIn
    ? state.user?.name || state.user?.email || state.user?.mobile || ui('signedIn')
    : ui('signedOut');
  el.account.title = state.signedIn
    ? state.sameAccount
      ? ui('sameAccountTitle', { account: state.dshAccount?.contact ?? state.dshAccount?.name ?? '' })
      : state.dshAccount?.contact
        ? ui('dshAccountTitle', { account: state.dshAccount.contact })
        : ui('webSignedInTitle')
    : ui('webSignedOutTitle');
  el.signIn.hidden = state.signedIn;
  el.signOut.hidden = !state.signedIn;
  const disabled = !state.signedIn;
  el.input.disabled = disabled;
  el.send.disabled = disabled || state.streaming;
  el.attach.disabled = disabled;
  el.pickSession.disabled = disabled;
  el.newChat.disabled = disabled;
  el.history.disabled = disabled || state.sessions.length === 0;
  el.input.placeholder = disabled
    ? ui('placeholderSignedOut')
    : ui('placeholderReady');
  // A visible build tag: "the panel looks wrong" is usually a stale iframe, and
  // this makes that one glance instead of a conversation.
  const version = state.settings?.version ? `v${state.settings.version}` : '';
  if (version) {
    el.note.textContent = ui('note', { version });
    el.emptyHint.textContent = ui('emptyHint', { version });
  }
}

function renderToggles() {
  el.thinking.setAttribute('aria-pressed', String(state.thinking));
  el.search.setAttribute('aria-pressed', String(state.search));
}

/**
 * Static chrome: the labels the language toggle flips.
 *
 * Kept separate from `renderAccount` because these do not depend on the account,
 * and re-rendering them must not touch the transcript.
 */
function renderChrome() {
  const version = state.settings?.version ? `v${state.settings.version}` : '';
  el.langToggle.textContent = ui('language');
  // The toggle advertises the language it switches *to*, so each label comes from
  // the other table rather than from a literal here.
  el.langToggle.title = state.lang === 'zh' ? 'English' : UI_COPY.zh.language;
  el.newChat.textContent = ui('newChat');
  el.newChat.title = ui('newChat');
  el.history.textContent = ui('history');
  el.history.title = ui('historyTitle');
  el.signIn.textContent = ui('signIn');
  el.signOut.textContent = ui('signOut');
  el.send.textContent = ui('send');
  el.attach.textContent = ui('attachFile');
  el.attach.title = ui('attachFile');
  el.pickSession.textContent = ui('sessions');
  el.thinking.textContent = ui('thinking');
  el.search.textContent = ui('search');
  el.emptyTitle.textContent = 'DeepSeek Chat';
  el.emptyTagline.textContent = ui('tagline');
  if (version) {
    el.note.textContent = ui('note', { version });
    el.emptyHint.textContent = ui('emptyHint', { version });
  }
}

/**
 * Switch the interface language and repaint everything that carries text.
 * @param {'zh'|'en'} lang
 */
function setLanguage(lang) {
  state.lang = lang === 'en' ? 'en' : 'zh';
  try {
    window.localStorage.setItem('dsw-chat-lang', state.lang);
  } catch {
    /* storage may be unavailable */
  }
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
  renderChrome();
  renderAccount();
  renderChips();
  renderTranscript();
  renderSelectBar();
  if (gate.root !== null && !gate.root.hidden) renderGate();
}

/**
 * Context chips: three kinds share one rail — a workspace file addressed by path,
 * path, a dropped file whose text the browser read, and a DSH conversation
 * transcript addressed by session id.
 */
const CONTEXT_ICON = { file: ui('kindFile'), drop: ui('kindDrop'), session: ui('kindSession') };

function renderChips() {
  el.chips.replaceChildren(
    ...state.context.map((item) =>
      h(
        'span',
        { class: `chip chip-${item.kind}`, title: item.hint ?? item.label },
        h('span', { class: 'chip-kind', text: CONTEXT_ICON[item.kind] ?? ui('kindOther') }),
        h('span', { text: item.label }),
        h('button', {
          text: '×',
          title: ui('remove'),
          onclick: () => {
            state.context = state.context.filter((entry) => entry !== item);
            renderChips();
          },
        }),
      ),
    ),
  );
}

/** Add one context item, de-duplicated by kind + identity. */
function addContext(item) {
  const key = `${item.kind}:${item.path ?? item.id ?? item.name}`;
  const exists = state.context.some((entry) => `${entry.kind}:${entry.path ?? entry.id ?? entry.name}` === key);
  if (exists) {
    toast(ui('alreadyInContext'));
    return;
  }
  state.context.push(item);
  renderChips();
}

function resetInputHeight() {
  el.input.style.height = 'auto';
}

function renderEmpty() {
  el.empty.hidden = state.messages.length > 0;
}

function renderTranscript() {
  el.transcript.replaceChildren();
  state.messages.forEach((message, index) => el.transcript.append(renderMessage(message, index)));
  el.empty.hidden = state.messages.length > 0;
  renderSelectBar();
  scrollToBottom();
}

function renderMessage(message, index = -1) {
  const bubble = h('div', { class: 'bubble' });
  if (message.text) bubble.append(renderRichText(message.text, message.sources ?? []));
  if (message.pending && !message.text) bubble.append(h('span', { class: 'status-line', text: ui('pondering') }));

  const parts = [];
  if (message.role === 'assistant' && message.thinking) {
    parts.push(
      h(
        'details',
        { class: 'thinking' },
        h('summary', { text: ui('thinkingSummary') }),
        h('div', { class: 'body', text: message.thinking }),
      ),
    );
  }
  if (message.searchUsed) {
    parts.push(h('div', { class: 'meta' }, h('span', { class: 'tag', text: ui('searched') })));
  }
  parts.push(bubble);
  if (message.role === 'assistant' && (message.sources ?? []).length > 0) {
    const list = h('ol', { class: 'sources' });
    for (const source of message.sources) {
      list.append(
        h(
          'li',
          {},
          h('a', { href: source.url, target: '_blank', rel: 'noreferrer noopener', text: source.title || source.url }),
        ),
      );
    }
    parts.push(h('details', { class: 'sources-box' }, h('summary', { text: ui('sources', { n: message.sources.length }) }), list));
  }
  if (message.role === 'assistant' && message.tokens) {
    parts.push(h('div', { class: 'meta' }, h('span', { text: `${message.tokens} tokens` })));
  }
  // Copy / insert belong to finished answers only: streaming text would land in
  // the composer half-written.
  const answerable = message.role === 'assistant' && !message.pending && String(message.text ?? '').trim().length > 0;
  if (answerable) {
    const actions = h(
      'div',
      { class: 'msg-actions', hidden: state.selecting },
      h('button', {
        class: 'ghost',
        type: 'button',
        text: p('copy'),
        onclick: () => {
          copyAnswer(message);
        },
      }),
      h('button', {
        class: 'ghost',
        type: 'button',
        text: p('insert'),
        onclick: (event) => {
          insertAnswer(message, event.currentTarget);
        },
      }),
      h('button', {
        class: 'ghost',
        type: 'button',
        text: p('attach'),
        title: p('attach'),
        onclick: (event) => {
          attachAnswer(message, index, event.currentTarget);
        },
      }),
      h('button', {
        class: 'ghost',
        type: 'button',
        text: p('select'),
        onclick: () => {
          enterSelectMode();
        },
      }),
    );
    parts.push(actions);
  }
  const wrapper = h(
    'div',
    { class: `msg ${message.role}${message.error ? ' error' : ''}` },
    h('div', { class: 'role', text: message.role === 'user' ? ui('roleMe') : 'DeepSeek' }),
    ...parts,
  );
  // The select circle only makes sense for finished answers, in select mode.
  if (answerable && state.selecting) {
    const picked = state.selected.has(index);
    wrapper.classList.add('msg-selectable');
    wrapper.classList.toggle('msg-selected', picked);
    wrapper.prepend(
      h('button', {
        class: 'msg-select-check',
        type: 'button',
        'aria-pressed': String(picked),
        'aria-label': p('select'),
        text: picked ? '✓' : '',
        onclick: () => {
          toggleSelected(index);
        },
      }),
    );
  }
  return wrapper;
}

function scrollToBottom() {
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

/* ------------------------------------------------------- message actions */

/**
 * Copy one finished answer.
 * @param {{text?: string}} message
 */
async function copyAnswer(message) {
  const text = String(message.text ?? '');
  if (text.trim().length === 0) {
    toast(p('insertEmpty'));
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(p('copied'));
  } catch (error) {
    toast(String(error?.message ?? error));
  }
}

/** One insertion at a time: a second click must not interleave with the first. */
let inserting = false;

/* ------------------------------------------------------------ multi-select */

/** Turn multi-select on; the action rows give way to selection circles. */
function enterSelectMode() {
  if (state.selecting) return;
  state.selecting = true;
  state.selected.clear();
  renderTranscript();
}

/** Leave multi-select and forget the selection. */
function exitSelectMode() {
  if (!state.selecting) return;
  state.selecting = false;
  state.selected.clear();
  renderSelectBar();
  renderTranscript();
}

/**
 * Toggle one answer. Only the touched node and the bar are updated, so the
 * transcript never jumps while the user is picking.
 * @param {number} index Message index in `state.messages`.
 * @param {Element | null} node The `.msg` wrapper, when the click came from a circle.
 */
function toggleSelected(index, node) {
  if (state.selected.has(index)) state.selected.delete(index);
  else state.selected.add(index);
  const picked = state.selected.has(index);
  if (node !== null && node !== undefined) {
    node.classList.toggle('msg-selected', picked);
    const circle = node.querySelector('.msg-select-check');
    if (circle !== null) {
      circle.setAttribute('aria-pressed', String(picked));
      circle.textContent = picked ? '✓' : '';
    }
  }
  renderSelectBar();
}

/** Selected answers in conversation order, ready for `joinAnswers`. */
function selectedAnswers() {
  return [...state.selected]
    .filter((index) => state.messages[index] !== undefined)
    .sort((left, right) => left - right)
    .map((index) => ({ text: String(state.messages[index].text ?? ''), at: index }));
}

/** Reflect the selection in the floating bar. */
function renderSelectBar() {
  if (!state.selecting) {
    el.selectBar.hidden = true;
    return;
  }
  const count = state.selected.size;
  el.selectCount.textContent = pf('selectedCount', { n: count });
  el.selectInsert.textContent = pf('insertSelected', { n: count });
  el.selectCopy.textContent = pf('copySelected', { n: count });
  el.selectCancel.textContent = p('cancel');
  el.selectInsert.disabled = count === 0;
  el.selectCopy.disabled = count === 0;
  el.selectBar.hidden = false;
}

/**
 * Ask before crossing a batch limit. Callback style on purpose: closing the
 * dialog by Esc or by clicking the backdrop must not leave a pending promise.
 * @param {{count: number, chars: number}} batch
 * @param {() => void} onConfirm
 */
function confirmBatch(batch, onConfirm) {
  openModal({
    title: p('select'),
    body: [h('div', { class: 'help', text: pf('tooLong', { n: batch.count, c: batch.chars }) })],
    footer: [
      h('button', { text: p('cancel'), onclick: closeModal }),
      h('button', {
        class: 'primary',
        text: p('stillInsert'),
        onclick: () => {
          closeModal();
          onConfirm();
        },
      }),
    ],
  });
}

/**
 * Insert the whole selection in one call, so the caret moves once.
 * @param {{text: string, count: number}} batch
 */
async function applyBatchInsert(batch) {
  try {
    const result = await insertIntoHostComposer(batch.text, { lang: state.lang });
    if (result.ok) toast(pf('insertedSelected', { n: batch.count }));
    else if (result.via === 'clipboard' && !String(result.reason ?? '').includes('no-clipboard')) {
      toast(p('insertedClipboard'));
    } else {
      toast(p('insertFailed'));
    }
  } catch (error) {
    toast(String(error?.message ?? error));
  }
  exitSelectMode();
}

/** Batch insert: same bridging as a single answer, one joined document. */
async function insertSelectedAnswers() {
  const answers = selectedAnswers();
  if (answers.length === 0) {
    toast(p('selectEmpty'));
    return;
  }
  const batch = joinAnswers(answers, { lang: state.lang });
  if (batch.overLimit) {
    confirmBatch(batch, () => {
      applyBatchInsert(batch);
    });
    return;
  }
  await applyBatchInsert(batch);
}

/** Batch copy: the same joined document, on the clipboard. */
async function copySelectedAnswers() {
  const answers = selectedAnswers();
  if (answers.length === 0) {
    toast(p('selectEmpty'));
    return;
  }
  const batch = joinAnswers(answers, { lang: state.lang });
  try {
    await navigator.clipboard.writeText(batch.text);
    toast(pf('copiedSelected', { n: batch.count }));
  } catch (error) {
    toast(String(error?.message ?? error));
  }
  exitSelectMode();
}

/**
 * Put one finished answer into the DSH composer as a **file attachment**.
 *
 * The bridge pastes a synthetic `File`; the composer uploads it through its own
 * intake path and renders a chip. When this DSH build does not turn the paste
 * into a chip (or the file API is missing), the answer is inserted as text
 * instead, and the toast says so.
 * @param {{text?: string, id?: string}} message
 * @param {number} index Message index, used for the file name when there is no id.
 * @param {HTMLButtonElement} [button]
 */
async function attachAnswer(message, index, button) {
  const text = String(message.text ?? '');
  if (text.trim().length === 0) {
    toast(p('insertEmpty'));
    return;
  }
  if (inserting) return;
  inserting = true;
  if (button !== undefined) button.disabled = true;
  try {
    const result = await insertAsAttachment(text, {
      lang: state.lang,
      id: message.id ?? String(index),
    });
    if (result.ok) {
      toast(p('attached'));
      return;
    }
    // Fallback: the same answer as text, so the click never ends in nothing.
    const fallback = await insertIntoHostComposer(text, { lang: state.lang });
    if (fallback.ok) toast(p('attachedFallback'));
    else if (fallback.via === 'clipboard' && !String(fallback.reason ?? '').includes('no-clipboard')) {
      toast(p('insertedClipboard'));
    } else {
      toast(p('attachFailed'));
    }
  } catch (error) {
    toast(String(error?.message ?? error));
  } finally {
    inserting = false;
    if (button !== undefined) button.disabled = false;
  }
}

/**
 * Put one finished answer into the DSH composer as text.
 *
 * The bridge focuses the composer itself; nothing here sends the message, and
 * focus is never pulled back to the panel afterwards.
 * @param {{text?: string}} message
 * @param {HTMLButtonElement} [button]
 */
async function insertAnswer(message, button) {
  const text = String(message.text ?? '');
  if (text.trim().length === 0) {
    toast(p('insertEmpty'));
    return;
  }
  if (inserting) return;
  inserting = true;
  if (button !== undefined) button.disabled = true;
  try {
    const result = await insertIntoHostComposer(text, { lang: state.lang });
    if (result.ok) toast(p('inserted'));
    else if (result.via === 'clipboard' && !String(result.reason ?? '').includes('no-clipboard')) {
      toast(p('insertedClipboard'));
    } else {
      toast(p('insertFailed'));
    }
  } catch (error) {
    toast(String(error?.message ?? error));
  } finally {
    inserting = false;
    if (button !== undefined) button.disabled = false;
  }
}

/* ------------------------------------------------------------------- data */

async function refreshStatus() {
  const payload = await request('status');
  state.signedIn = Boolean(payload.signedIn);
  state.user = payload.user ?? null;
  state.workspace = payload.workspace ?? { root: '', name: '' };
  state.settings = payload.settings ?? {};
  state.dshAccount = payload.dshAccount ?? null;
  state.sameAccount = payload.sameAccount === true;
  state.thinking = Boolean(payload.settings?.thinking);
  state.search = Boolean(payload.settings?.search);
  if (payload.settings?.theme) document.documentElement.dataset.theme = payload.settings.theme;
  renderAccount();
  renderToggles();
}

async function refreshSessions() {
  if (!state.signedIn) {
    state.sessions = [];
    el.history.disabled = true;
    return;
  }
  try {
    const payload = await request('sessions');
    state.sessions = payload.sessions ?? [];
    el.history.disabled = state.sessions.length === 0;
  } catch (error) {
    toast(String(error.message ?? error));
  }
}

async function openSession(sessionId) {
  const payload = await request('history', { body: { sessionId } });
  state.sessionId = payload.session?.id ?? sessionId;
  // A different transcript invalidates any selection from the previous one.
  state.selecting = false;
  state.selected.clear();
  state.messages = (payload.messages ?? []).map((message) => ({
    role: message.role,
    text: message.text,
    thinking: message.thinking,
    tokens: message.accumulatedTokens,
    searchUsed: message.searchEnabled,
  }));
  renderTranscript();
}

function newChat() {
  state.sessionId = null;
  state.messages = [];
  state.context = [];
  state.selecting = false;
  state.selected.clear();
  renderChips();
  renderTranscript();
  el.input.focus();
}

/* ------------------------------------------------------------------- chat */

async function send() {
  const prompt = el.input.value.trim();
  if (prompt.length === 0 || state.streaming || !state.signedIn) return;

  el.input.value = '';
  resetInputHeight();
  state.streaming = true;
  renderAccount();

  state.messages.push({ role: 'user', text: prompt });
  const assistant = { role: 'assistant', text: '', thinking: '', pending: true };
  state.messages.push(assistant);
  renderTranscript();
  scrollToBottom();

  try {
    const controller = new AbortController();
    const response = await fetch(`${API_BASE}chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        prompt,
        thinking: state.thinking,
        search: state.search,
        paths: state.context.filter((item) => item.kind === 'file').map((item) => item.path),
        inline: state.context.filter((item) => item.kind === 'drop').map((item) => ({ name: item.name, text: item.text })),
        sessions: state.context.filter((item) => item.kind === 'session').map((item) => item.id),
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `HTTP ${response.status}`);
    }
    await consumeStream(response.body, (event) => {
      if (event.type === 'ready') {
        state.sessionId = event.sessionId ?? state.sessionId;
        assistant.pending = true;
      } else if (event.type === 'text') {
        assistant.text += event.text;
        assistant.pending = false;
        repaintAssistant();
      } else if (event.type === 'thinking') {
        assistant.thinking += event.text;
        repaintAssistant();
      } else if (event.type === 'search') {
        assistant.searchUsed = true;
        if (Array.isArray(event.results) && event.results.length > 0) {
          const merged = assistant.sources ?? [];
          for (const source of event.results) {
            if (!merged.some((item) => item.url === source.url)) merged.push(source);
          }
          assistant.sources = merged;
        }
        repaintAssistant();
      } else if (event.type === 'mode') {
        if (event.mode === 'SEARCH') assistant.searchUsed = true;
        repaintAssistant();
      } else if (event.type === 'usage') {
        assistant.tokens = event.tokens;
        repaintAssistant();
      } else if (event.type === 'title' && event.title) {
        state.title = event.title;
      } else if (event.type === 'error') {
        assistant.error = true;
        assistant.text = assistant.text || String(event.message ?? ui('requestFailed'));
        repaintAssistant();
      }
    });
    if (!assistant.text && !assistant.error) {
      assistant.text = ui('noContent');
    }
    assistant.pending = false;
    repaintAssistant();
    state.context = [];
    renderChips();
  } catch (error) {
    assistant.pending = false;
    assistant.error = true;
    assistant.text = String(error.message ?? error);
    repaintAssistant();
  } finally {
    state.streaming = false;
    renderAccount();
    refreshSessions().catch(() => {});
  }
}

function repaintAssistant() {
  const index = state.messages.length - 1;
  const node = el.transcript.lastElementChild;
  const fresh = renderMessage(state.messages[index], index);
  if (node && node.classList.contains('msg')) node.replaceWith(fresh);
  else el.transcript.append(fresh);
  el.empty.hidden = true;
  scrollToBottom();
}

/** Read `data:`-only SSE frames written by the host route. */
async function consumeStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0) continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          /* ignore malformed keep-alive frames */
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
}

/* ------------------------------------------------------------------ modals */

function openModal({ title, body, footer }) {
  el.modalTitle.textContent = title;
  el.modalBody.replaceChildren(...body);
  el.modalFoot.replaceChildren(...footer);
  el.modal.classList.add('open');
}

function closeModal() {
  el.modal.classList.remove('open');
  el.modalBody.replaceChildren();
  el.modalFoot.replaceChildren();
}

/**
 * Click-to-add fallback for the dragged conversation: pick a DSH session from a
 * list instead of dragging it. The Host reads the transcript, so nothing but the
 * id travels from this list.
 */
async function openSessionPicker() {
  const status = h('div', { class: 'status-line', text: ui('readingSessions') });
  openModal({
    title: ui('dshSessionsTitle'),
    body: [status],
    footer: [h('button', { text: ui('close'), onclick: closeModal })],
  });
  try {
    const query = new URLSearchParams({ limit: '15' });
    if (state.workspace?.root) query.set('cwd', state.workspace.root);
    const payload = await request(`dsh-sessions?${query.toString()}`);
    const list = h('div', { class: 'sessions' });
    const sessions = payload.sessions ?? [];
    if (sessions.length === 0) {
      status.textContent = ui('noDshSessions');
      return;
    }
    for (const session of sessions) {
      list.append(
        h(
          'button',
          {
            onclick: () => {
              addContext({
                kind: 'session',
                id: session.id,
                label: session.title || ui('sessionLabel', { id: session.id.slice(0, 8) }),
                hint: `${session.title ?? session.id} · ${ui('messagesCount', { n: session.messages ?? 0 })}`,
              });
              toast(ui('transcriptNotice'));
              closeModal();
            },
          },
          h('span', { class: 't', text: session.title || ui('sessionLabel', { id: session.id.slice(0, 8) }) }),
          h('span', {
            class: 'd',
            text: `${ui('messagesCount', { n: session.messages ?? 0 })}${session.error ? ` · ${session.error}` : ''}`,
          }),
        ),
      );
    }
    status.replaceWith(list);
  } catch (error) {
    status.textContent = ui('readFailed', { message: String(error?.message ?? error) });
  }
}

function openHistory() {  const list = h('div', { class: 'sessions' });
  for (const session of state.sessions) {
    list.append(
      h(
        'button',
        {
          onclick: async () => {
            closeModal();
            try {
              await openSession(session.id);
            } catch (error) {
              toast(String(error.message ?? error));
            }
          },
        },
        h('span', { class: 't', text: session.title || ui('untitled') }),
        h('span', { class: 'd', text: formatRelative(session.updatedAt) }),
      ),
    );
  }
  if (state.sessions.length === 0) list.append(h('div', { class: 'status-line', text: ui('noHistory') }));
  openModal({
    title: ui('historyTitle'),
    body: [list],
    footer: [h('button', { text: ui('close'), onclick: closeModal })],
  });
}

async function openFilePicker(path = '') {
  state.pickerPath = path;
  const payload = await request(`files?path=${encodeURIComponent(path)}`);
  const list = h('ul', { id: 'file-list' });
  if (path) {
    list.append(
      h(
        'li',
        { class: 'up', onclick: () => openFilePicker(parentOf(path)) },
        h('span', { class: 'icon', text: '↑' }),
        h('span', { class: 'name', text: ui('back') }),
      ),
    );
  }
  for (const entry of payload.entries ?? []) {
    const row = h(
      'li',
      {
        onclick: () => {
          if (entry.kind === 'directory') openFilePicker(entry.path);
          else togglePicked(entry.path, row);
        },
      },
      h('span', { class: 'icon', text: entry.kind === 'directory' ? '▸' : '·' }),
      h('span', { class: 'name', text: entry.name }),
      h('span', { class: 'size', text: entry.kind === 'directory' ? '' : `${Math.max(1, Math.round((entry.size ?? 0) / 1024))} KB` }),
    );
    if (state.pickerSelection.has(entry.path) || state.context.some((item) => item.path === entry.path)) row.style.background = 'var(--dsw-accent-weak)';
    list.append(row);
  }
  if ((payload.entries ?? []).length === 0) {
    list.append(h('li', {}, h('span', { class: 'name', text: ui('emptyDirectory') })));
  }
  const crumbs = h('div', { id: 'path-crumbs', text: `${payload.root ?? ''}/${payload.path ?? ''}` });
  openModal({
    title: ui('filesTitle'),
    body: [crumbs, list],
    footer: [
      h('button', {
        text: ui('clear'),
        onclick: () => {
          state.context = [];
          state.pickerSelection.clear();
          renderChips();
          closeModal();
        },
      }),
      h('button', {
        class: 'primary',
        text: ui('done'),
        onclick: () => {
          for (const path of state.pickerSelection) {
            addContext({ kind: 'file', path, label: path.split('/').pop(), hint: path });
          }
          state.pickerSelection.clear();
          renderChips();
          closeModal();
        },
      }),
    ],
  });
}

function togglePicked(path, row) {
  if (state.pickerSelection.has(path)) {
    state.pickerSelection.delete(path);
    row.style.background = '';
  } else {
    state.pickerSelection.add(path);
    row.style.background = 'var(--dsw-accent-weak)';
  }
}

function parentOf(path) {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/* --------------------------------------------------------- drag and drop */

/**
 * Drag & drop intake.
 *
 * Two payloads matter here:
 *  - `Files`, from Explorer or any OS drag. Electron 44 no longer exposes
 *    `File.path`, so the text is read in the browser and forwarded inline; the
 *    Host never needs a filesystem path.
 *  - `text/plain` carrying a DSH session id, which is what the sidebar's
 *    conversation rows put on the transfer. The Host resolves that transcript
 *    through the session persistence service.
 */
// DSH session ids look like session-<uuid>; accept the bare uuid too.
const SESSION_ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let dragDepth = 0;

function dragKinds(event) {
  const types = event.dataTransfer?.types;
  if (!types) return { files: false, text: false };
  return { files: Array.from(types).includes('Files'), text: Array.from(types).includes('text/plain') };
}

/**
 * Pick a drop effect the drag source actually allows.
 *
 * `dropEffect` must be a subset of `effectAllowed`, or the browser cancels the
 * whole drop: DSH's session rows start a `move` drag, so insisting on `copy`
 * turned the cursor into the red "no drop" sign and `drop` never fired.
 */
function compatibleDropEffect(dataTransfer) {
  const allowed = dataTransfer.effectAllowed;
  // We only ever copy data, so prefer `copy` whenever the source permits it;
  // `move` is required only for sources that allow nothing else (DSH's rows).
  if (allowed === 'all' || allowed === 'copy' || allowed === 'copyMove' || allowed === 'copyLink' || allowed === 'uninitialized') {
    return 'copy';
  }
  if (allowed === 'move' || allowed === 'linkMove') return 'move';
  return 'copy';
}

function showDropOverlay(visible) {
  if (el.drop === null) return;
  el.drop.classList.toggle('open', visible);
}

async function addDroppedFile(file) {
  const max = Number(state.settings?.maxFileBytes ?? 200_000);
  if (file.size === 0) {
    toast(ui('emptyFile', { name: file.name }));
    return;
  }
  if (file.size > max) {
    toast(ui('fileTooLarge', { name: file.name, size: Math.round(max / 1024) }));
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch (error) {
    toast(ui('fileUnreadable', { name: file.name, message: String(error?.message ?? error) }));
    return;
  }
  if (text.includes('\u0000')) {
    toast(ui('fileBinary', { name: file.name }));
    return;
  }
  addContext({
    kind: 'drop',
    name: file.name,
    text,
    label: file.name,
    hint: `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`,
  });
}

async function addDroppedSession(id) {
  try {
    const preview = await request('session-preview', { body: { id } });
    addContext({
      kind: 'session',
      id,
      label: preview.title ?? ui('sessionLabel', { id: id.slice(0, 8) }),
      hint: `${preview.title ?? id} · ${ui('messagesCount', { n: preview.messages })} · ${Math.round((preview.bytes ?? 0) / 1024)} KB`,
    });
    toast(ui('transcriptNotice'));
  } catch (error) {
    toast(ui('readFailed', { message: String(error?.message ?? error) }));
  }
}

document.addEventListener('dragenter', (event) => {
  const kinds = dragKinds(event);
  if (!kinds.files && !kinds.text) return;
  event.preventDefault();
  dragDepth += 1;
  showDropOverlay(true);
});

document.addEventListener('dragover', (event) => {
  const kinds = dragKinds(event);
  if (!kinds.files && !kinds.text) return;
  // Cancelling the default is what makes this element a drop target at all;
  // the effect then has to agree with what the drag source permits.
  event.preventDefault();
  const dataTransfer = event.dataTransfer;
  if (dataTransfer) {
    dataTransfer.dropEffect = compatibleDropEffect(dataTransfer);
    document.body.dataset.dragEffect = `${dataTransfer.effectAllowed}->${dataTransfer.dropEffect}`;
  }
  showDropOverlay(true);
});

document.addEventListener('dragleave', (event) => {
  const kinds = dragKinds(event);
  if (!kinds.files && !kinds.text) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDropOverlay(false);
});

document.addEventListener('drop', (event) => {
  const kinds = dragKinds(event);
  if (!kinds.files && !kinds.text) {
    // Record what did arrive: without it, "drag does nothing" is hard to tell
    // apart from "the drag never reached the iframe".
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
    document.body.dataset.dropTypes = types.join(',') || '(none)';
    if (types.length > 0) toast(ui('unsupportedTypes', { types: types.join(' / ') }));
    return;
  }
  event.preventDefault();
  dragDepth = 0;
  showDropOverlay(false);
  document.body.dataset.dropTypes = Array.from(event.dataTransfer?.types ?? []).join(',');
  if (!state.signedIn) {
    toast(ui('signedOutFirst'));
    return;
  }
  if (kinds.files && (event.dataTransfer?.files?.length ?? 0) > 0) {
    for (const file of event.dataTransfer.files) {
      addDroppedFile(file).catch((error) => toast(String(error?.message ?? error)));
    }
    return;
  }
  const text = event.dataTransfer.getData('text/plain').trim();
  if (SESSION_ID.test(text)) {
    addDroppedSession(text).catch((error) => toast(String(error?.message ?? error)));
    return;
  }
  if (text.length > 0 && PATH_LIKE.test(text)) {
    // A file row dragged out of DSH's own tree carries its workspace path.
    addContext({
      kind: 'file',
      path: text,
      label: text.split(/[\\/]/u).pop() ?? text,
      hint: text,
    });
    return;
  }
  if (text.length > 0) {
    // Anything else (a text selection, or a tree row's opaque id) goes into the
    // composer so the user can see and edit what arrived.
    insertIntoComposer(text);
    return;
  }
  toast(ui('unsupportedDrop'));
});

/** A single-line, path-shaped string: safe to treat as a workspace path. */
const PATH_LIKE = /^[\w.@~+$()\- \\/]{2,400}$/u;

function insertIntoComposer(text) {
  const start = el.input.selectionStart ?? el.input.value.length;
  const end = el.input.selectionEnd ?? start;
  const before = el.input.value.slice(0, start);
  const after = el.input.value.slice(end);
  el.input.value = `${before}${text}${after}`;
  el.input.selectionStart = el.input.selectionEnd = start + text.length;
  el.input.focus();
  el.input.dispatchEvent(new Event('input'));
}

/* ------------------------------------------------------------------- wire */

/**
 * One successful sign-in.
 * @param {{user?: object}} payload Reply from `/api/login`.
 */
async function gateSignedIn(payload) {
  gate.token.value = '';
  gate.status.textContent = '';
  state.signedIn = true;
  state.user = payload.user ?? null;
  renderAccount();
  await refreshSessions();
  toast(t('welcome'));
}

/** The pasted userToken is the only sign-in input. */
async function submitGateToken() {
  const token = parsePastedToken(gate.token.value);
  if (token.length === 0) {
    gate.status.textContent = t('missingToken');
    return;
  }
  gate.status.textContent = t('verifying');
  try {
    const payload = await request('login', { body: { token } });
    await gateSignedIn(payload);
  } catch (error) {
    gate.status.textContent = String(error?.message ?? error);
  }
}

gate.submit.addEventListener('click', () => {
  submitGateToken().catch((error) => {
    gate.status.textContent = String(error?.message ?? error);
  });
});
// Ctrl+Enter submits without leaving the textarea.
gate.token.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submitGateToken();
});
gate.browser.addEventListener('click', () => {
  // The shell turns a new-window request into `shell.openExternal`, so this opens
  // the real site in the system browser, where every official sign-in method works.
  try {
    window.open('https://chat.deepseek.com/', '_blank', 'noopener,noreferrer');
    gate.status.textContent = '';
    gate.token.focus();
    toast(t('opened'));
  } catch (error) {
    gate.status.textContent = String(error?.message ?? error);
  }
});
for (const [button, lang] of [
  [gate.langZh, 'zh'],
  [gate.langEn, 'en'],
]) {
  button.addEventListener('click', () => {
    setLanguage(lang);
  });
}

// The top-bar toggle flips the whole panel, gate included.
el.langToggle.addEventListener('click', () => {
  setLanguage(state.lang === 'zh' ? 'en' : 'zh');
});

function autoready() {
  el.input.style.height = 'auto';
}

el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 180)}px`;
});

el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});

el.send.addEventListener('click', send);
// The gate is the only sign-in surface; this button just re-reveals it.
el.signIn.addEventListener('click', () => showGate(true));
el.signOut.addEventListener('click', async () => {
  try {
    await request('logout', { body: {} });
    state.signedIn = false;
    state.user = null;
    state.messages = [];
    state.sessionId = null;
    renderAccount();
    renderTranscript();
    refreshSessions().catch(() => {});
    toast(ui('loggedOut'));
  } catch (error) {
    toast(String(error.message ?? error));
  }
});
el.newChat.addEventListener('click', newChat);
el.history.addEventListener('click', openHistory);
el.attach.addEventListener('click', () => {
  state.pickerSelection.clear();
  openFilePicker('').catch((error) => toast(String(error.message ?? error)));
});
el.pickSession.addEventListener('click', () => {
  openSessionPicker().catch((error) => toast(String(error.message ?? error)));
});
el.thinking.addEventListener('click', () => {
  state.thinking = !state.thinking;
  renderToggles();
});
el.search.addEventListener('click', () => {
  state.search = !state.search;
  renderToggles();
});
el.modal.addEventListener('click', (event) => {
  if (event.target === el.modal) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeModal();
  exitSelectMode();
});

// Multi-select bar: insert / copy the whole selection, or leave the mode.
el.selectInsert.addEventListener('click', () => {
  insertSelectedAnswers().catch((error) => toast(String(error?.message ?? error)));
});
el.selectCopy.addEventListener('click', () => {
  copySelectedAnswers().catch((error) => toast(String(error?.message ?? error)));
});
el.selectCancel.addEventListener('click', exitSelectMode);

/* ------------------------------------------------------------------- boot */

(function applyThemeFromQuery() {
  const theme = new URLSearchParams(window.location.search).get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
})();

(async function boot() {
  document.body.dataset.boot = 'started';
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
  renderChrome();
  renderAccount();
  renderToggles();
  renderChips();
  renderTranscript();
  try {
    await refreshStatus();
    document.body.dataset.boot = `status:${state.signedIn ? 'signed-in' : 'signed-out'}`;
    await refreshSessions();
    // Deep link: ?session=<id> opens an existing conversation.
    const requested = new URLSearchParams(window.location.search).get('session');
    if (state.signedIn && requested) await openSession(requested);
    // Signed out shows the gate; `renderAccount` already did, this re-focuses it.
    showGate(!state.signedIn);
  } catch (error) {
    document.body.dataset.boot = `failed:${String(error?.message ?? error).slice(0, 120)}`;
    toast(String(error.message ?? error));
  }
})();
