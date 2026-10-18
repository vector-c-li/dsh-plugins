# DeepSeek Chat · DSH plugin

English · [中文](README.zh-CN.md)

A **DSH** (DeepSeek Harness) plugin that puts a chat.deepseek.com panel in the right sidebar, so you
can ask the web chat anything without leaving the app — optionally with files from the current
workspace, or a DSH conversation, attached as context.

Part of the [`dsh-plugins`](https://github.com/vector-c-li/dsh-plugins) collection.

![sign-in page](docs/gate-en.png)

## What it does

| | |
|---|---|
| **Sidebar tab** | Registers a `DeepSeek Chat` tab in DSH's right sidebar (`DeepSeek Chat` in the `+` menu). |
| **Your own account** | Talks to `chat.deepseek.com` with *your* `userToken`; no API key, no proxy, no third-party server. |
| **Thinking / search** | Two toggles that mirror the site's `深度思考` and `联网搜索` switches. |
| **Workspace context** | Attach files from the current workspace (picker or drag-and-drop); they are inlined into the prompt. |
| **DSH conversation context** | Drag a sidebar conversation in (or use the `会话` button); the Host reads the transcript and folds it into the prompt. |
| **History** | Browse and continue existing web conversations. |
| **Insert into DSH** | Every finished answer has **Copy** and **Insert into DSH**: the text goes into the DSH composer at the caret, for you to edit. It is never sent automatically. |
| **Bilingual sign-in** | The pre-login page is Chinese/English with a four-step illustrated guide. |

## Requirements

- DSH with the **desktop** profile (the sidebar tab needs `@deepseek-ai/dsh-client-ui-sidebar-right`).
- A `chat.deepseek.com` account.

## Install

### Fast path: paste one spec into DSH

Open **Plugins → Add plugin** in DSH and paste:

```
github:vector-c-li/dsh-plugins#path:/plugins/deepseek-web-chat
```

DSH reads the spec, installs the package with pnpm and enables it as a bundle. Then refresh the DSH
page (restart once if the tab does not appear) and open **DeepSeek Chat** from the sidebar `+`.

The same spec works from a terminal, but the CLI only installs the package — enable it afterwards in
the Plugins page:

```powershell
dsh plugin --profile desktop add "github:vector-c-li/dsh-plugins#path:/plugins/deepseek-web-chat"
```

Everything else, including the proof-of-work module, is fetched automatically on first use (cached
under `$DSH_HOME/cache/deepseek-web-chat/`). To upgrade, install the same spec again — a git install
is a snapshot, so reinstalling is what pulls a newer commit.

### Manual path (for development)

#### 1. Clone

```powershell
git clone https://github.com/vector-c-li/dsh-plugins.git "$env:USERPROFILE\dsh-plugins"
```

```bash
git clone https://github.com/vector-c-li/dsh-plugins.git ~/dsh-plugins
```

The plugin lives at `<clone>/plugins/deepseek-web-chat`.

#### 2. Fetch the PoW module (optional)

A git install downloads the module on demand, so this step is only needed for an offline machine or
if you want the copy checked in your checkout (see [Third-party assets](#third-party-assets)):

```powershell
node plugins\deepseek-web-chat\scripts\fetch-wasm.mjs
```

It writes `assets/sha3_wasm_bg.wasm` (~26 KB) from `fe-static.deepseek.com`. Without a local copy the
Host downloads it once into `$DSH_HOME/cache/deepseek-web-chat/` on the first challenge.

#### 3. Register it with your DSH profile

Edit `$DSH_HOME/profiles/desktop/package.json` (on Windows `C:\Users\<you>\.dsh\profiles\desktop`):

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-deepseek-web-chat"] } },
  "dependencies": {
    "dsh-deepseek-web-chat": "link:<abs path to plugins/deepseek-web-chat>"
  }
}
```

Then link it into the profile's `node_modules` — on Windows a directory junction is enough:

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-deepseek-web-chat" "$env:USERPROFILE\dsh-plugins\plugins\deepseek-web-chat"
```

On macOS/Linux use a symlink instead:

```bash
ln -s ~/dsh-plugins/plugins/deepseek-web-chat ~/.dsh/profiles/desktop/node_modules/dsh-deepseek-web-chat
```

Finally add the host row to `$DSH_HOME/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
    - id: deepseek-web-chat
      name: "file:///<abs path to plugins/deepseek-web-chat>/lib/index.js"
      config:
        locale: zh_CN
```

Restart DSH (or toggle the plugin off/on in the Plugins page).

#### 4. Verify, then sign in

- Open `http://127.0.0.1:<dsh port>/deepseek-web/` — you should get the sign-in page;
- Or refresh DSH and open the **DeepSeek Chat** tab from the sidebar `+` menu.

Sign-in needs a `userToken`; the panel walks you through it in four illustrated steps, and
[`docs/guide.en.md`](docs/guide.en.md) has the long version.

## Troubleshooting

**`组件启用失败 … duplicate prefix route "/deepseek-web"`**
Two enabled rows claim the same HTTP prefix — typically a local development row (`file://…`) left
over from before, plus the installed bundle. Disable one of them in **Plugins**, then reload:

- developed from a checkout? keep the `file://` row and uninstall the bundle;
- installed from git? keep the bundle and disable the `file://` row (or delete that row from
  `$DSH_HOME/profiles/desktop/cordis.patch.yml`).

`v0.7.3` and later log a readable warning for this case instead of failing activation.

**`连接 GitHub 超时` / `无法访问 GitHub` while installing**
The Host reaches GitHub through git, so a blocked direct route fails the install even when a browser
works. Two ways out:

- **Proxy**: point git at the proxy that already works for your browser, then retry the same spec —
  `git config --global http.proxy http://127.0.0.1:7897` (adjust the port; undo with
  `git config --global --unset http.proxy`). `~/.npmrc` with `proxy=` / `https-proxy=` covers pnpm's
  own registry calls.
- **Tarball**: build one locally and install from the file, no network needed —

  ```powershell
  pnpm pack --pack-destination dist        # in plugins/deepseek-web-chat
  ```

  then paste `<abs path>/dist/dsh-deepseek-web-chat-<version>.tgz` into **Add plugin**. A tarball
  installs as a copy, so uninstalling never touches your source folder.

**The panel is served but the sidebar tab is missing**
The Host half and the browser half load separately: toggle the plugin off/on, then refresh the DSH
page (restart once if it still does not appear).

**`proof-of-work module is missing`**
The wasm blob is downloaded on first use into `$DSH_HOME/cache/deepseek-web-chat/`. If that network
path is blocked, run `node scripts/fetch-wasm.mjs` in the plugin directory (or point `wasmPath` at a
local copy) and reload.

**Upgrading**
A git install is a snapshot: paste the spec again (or `dsh plugin --profile desktop add …`) and
enable the plugin, then refresh.

## Insert into DSH

Each finished answer carries four actions: **Copy**, **Insert into DSH**, **Insert as file** and
**Select**.

**Insert into DSH** writes the answer — plain-text Markdown, code fences intact — into the DSH
composer at the caret, then puts the caret after it. If the composer already holds text, a blank line
is inserted first so the two never glue together. The message is **not** sent: review and edit it
yourself. A prompt-injected answer therefore cannot trigger a tool call on its own.

**Insert as file** puts `answer-<message id>.md` into the composer as a real attachment chip, using the
composer's own file intake (a synthetic `paste` carrying a `File`): DSH uploads the bytes through its
official route and renders the chip. If this DSH build does not turn that paste into a chip, the answer
is inserted as text instead and the toast says so — the click never ends in nothing.

The panel is a same-origin iframe, so `lib/web/composer-bridge.js` reaches the Host composer through
`window.parent` and degrades in this order, logging `composer bridge: …` at every miss:

| Tier | Mechanism | When it is used |
|---|---|---|
| 1 | `element.insertText` | Only if a future DSH exposes such a method on the composer |
| 2 | synthetic `paste` | Normal path: the composer is a Lexical editor and this is its clipboard route |
| 3 | `execCommand('insertText')` / textarea setter | If the paste event is ignored, or the composer is a plain `<textarea>` |
| 4 | clipboard | If no composer is found or every DOM layer fails: the text is copied and a toast says so |

Attachment insertion is a separate entry point (`insertAsAttachment`) that rides the composer's
`PASTE_COMMAND`: it reads `clipboardData.items` of kind `file` and hands them to `intakeFiles`, which is
why a JS-built `File` (no host path) takes the upload branch and becomes a chip.

There is deliberately no service/store layer: DSH exposes no draft-insertion API to plugins, and the
draft store is a per-session factory (`slots.register({ name: 'conversation.session', store })`) whose
`create(scope)` returns a fresh instance, so writing through it would not re-render the composer.

The composer selector lives in one constant (`COMPOSER_SELECTORS` in `composer-bridge.js`):
`[data-composer-input]` first, then `[role="textbox"][contenteditable="true"]`, then any visible
editable. DSH's own class names are CSS-module hashes and are never used.

### What an attached file means to the model, and where it lives

A **generic file** attachment is not inlined into the prompt. DSH projects it as a *text handle naming
its identity and a read-only process path* (`@deepseek-ai/dsh-attachment-local` → "Model Experience"), so
the model reads it with the read tool exactly as it would read an `@path` mention. Images are different:
they are normalized and sent as request bytes. In practice: **Insert into DSH** guarantees the text is
in the prompt; **Insert as file** guarantees a chip and a readable file, at the cost of a read call.

Storage, honestly:

- the bytes go to **DSH's own content-addressed attachment store** (`$DSH_HOME/attachments/v1/`), which
  dedupes identical bytes (inserting the same answer twice stores nothing new);
- DSH itself never prunes that store, so the panel runs its **own retention sweep** over the files it
  created (see below);
- the text button stores nothing at all.

### Retention sweep

`lib/host/attachment-gc.js` runs at mount and then every 6 hours:

| Setting | Default | Effect |
|---|---|---|
| `sessionContextMode` | `transcript` | `transcript` / `tools` / `file`: how a loaded DSH conversation reaches the prompt. |
| `maxSessionBytes` | `400000` | Per-session byte budget for the inline levels. |
| `attachmentRetentionDays` | `7` | Delete `answer-*.md` files older than this. `0` disables the sweep. |
| `attachmentPruneReferenced` | `false` | When `false`, a file that a stored conversation still references is **kept** regardless of age. |

The sweep only ever looks at `answer-*.md` — the name this panel gives its insertions — so images and
files you attached by hand are never candidates. It reads the session logs (one zstd frame per append,
all frames decoded) and collects every `sha256:<hash>` they mention; a hash that still appears keeps its
object. The shared content object is removed only when the last name pointing at it is gone. The newest
run is published in `status.attachmentRetention`, and the host logs a one-line summary whenever it frees
space.

If the runtime cannot decode zstd, the sweep degrades to **age-only** pruning and says so in
`status.attachmentRetention.lastSweep.mode`, rather than assuming "no references".

## Interface language

The whole panel is bilingual: the `EN` / `中文` button in the top bar flips every label — top bar,
composer, context chips, message roles, section summaries, dialogs, toasts and the sign-in page. The
choice is remembered in `localStorage` (`dsw-chat-lang`) and the sign-in gate follows the same setting.

All strings live in `lib/web/gate-copy.js` (`UI_COPY`, `PANEL_COPY`, `GATE_COPY`); `scripts/ui-copy-check.mjs`
fails the build if the two languages drift apart, if a lookup names a missing key, or if a Chinese
literal sneaks back into the panel script.

## Batch insert

**Select** on any answer enters multi-select mode: every finished answer gets a circle in its gutter,
the per-answer action rows step aside, and a bar appears above the composer with
`N selected · Insert N · Copy N · Cancel`. Leave it with `Cancel`, `Esc`, or by inserting/copying.

The selection is inserted as **one** document, in conversation order (oldest first):

- answers are separated by a blank line, `---`, blank line;
- each answer can carry `> 来自 DeepSeek Chat · 第 N 条` (or `· #N` in English), off by default like
  the single-answer marker;
- a single selected answer produces exactly the same payload as the single-answer button — no
  separator, numbering `1`.

Limits are checked before anything is written, and nothing is ever truncated:

| Limit | Threshold | Behaviour |
|---|---|---|
| Answers | more than 8 | asks first: `That is a lot of text — consider batches (N answers / M characters)` with **Insert anyway** / **Cancel** |
| Characters | more than 20000 | same prompt |

The whole batch goes through the same `insertIntoComposer` call, so the caret moves once and the
composer is focused when it ends. `joinAnswers()` in `composer-bridge.js` owns the ordering,
separators, numbering and limits; the panel only renders the bar and passes the selection.

The bar's **Attach N** button sends the same joined document as **one** file attachment
(`answer-batch-<n>-<stamp>.md`), so a long selection stays a single chip. It uses the same limits, the same
confirmation, and the same text fallback as **Insert N**.

## Configuration

All keys are optional; they go in the row's `config` block.

| Key | Default | Meaning |
|---|---|---|
| `routePrefix` | `/deepseek-web` | HTTP prefix for the panel and its JSON/SSE API. |
| `baseUrl` | `https://chat.deepseek.com` | Upstream site. |
| `locale` | `zh_CN` | `x-client-locale` sent upstream; also the default guide language. |
| `theme` | `''` | Force `light` / `dark`; empty follows DSH. |
| `thinking` | `false` | Default state of the 深度思考 toggle. |
| `search` | `false` | Default state of the 联网搜索 toggle. |
| `workspaceRoot` | first DSH workspace | Root for the file picker. |
| `maxFileBytes` | `200000` | Per-file cap when inlining context. |
| `maxContextBytes` | `400000` | Total context cap; overflow is truncated with a note. |
| `sessionPageSize` | `30` | Conversations per page (upstream clamps to 2–100). |
| `attachmentRetentionDays` | `7` | Retention for `answer-*.md` attachments the panel inserted; `0` disables the sweep. |
| `attachmentPruneReferenced` | `false` | Also prune attachments a stored conversation still references (age-only). |
| `wasmPath` | `assets/sha3_wasm_bg.wasm` | Proof-of-work module. |

## How context works

Three sources share one chip rail:

| Chip | Source | How it reaches the prompt |
|---|---|---|
| File | Workspace file (picker or drag) | Read by the Host, inlined inside `<file path="…">` |
| Drop | A file dropped from the OS | Read in the browser, sent with the request, inlined |
| Session | A DSH conversation (drag from the sidebar, or `会话`) | Host folds up to 40 turns into `<conversation title="…">` |

Context is **text in the prompt**, not an uploaded attachment. Tool calls inside a DSH conversation
are collapsed into a one-line tally, so long agentic transcripts stay readable.

### The session picker

A DSH session log carries no title of its own — the title the sidebar shows lives in the session
projection cache (`storages/session_projcache/sessions/<id>.json` → `record.rows.title.val`). The picker
reads it, so rows are named the way you named that conversation.

Loading is **two steps**:

1. **Pick the conversation.** Rows show the title only — it is unique, and it is all the choice needs;
   the search box filters on it. Sessions created by pressing *new chat* and never used are hidden, and
   the footer says how many were hidden.
2. **Pick how to load it** — `正文 / 含工具 / 文件附件`. The pane below states what that level does and its
   numbers (`105 / 114 条 · 186 KB`): entries rendered of the total, and the bytes that will be sent.

**加入上下文** then attaches it. The title chain is `cached title → opening question → placeholder`; a
session id is never the primary label.

The numbers are a **host rendering, not a guess**: the panel calls
`GET api/session-context?id=…&mode=…`, which runs the same renderer the send path uses (no upload, no
completion), so what the pane reports is what the next request will contain.

### Text size follows the Host

The panel's interface keeps pace with DSH's chat text instead of sitting at a fixed 13 px:

- the Host's chat font size is measured through `window.parent` and compared against a **baseline captured
  at 100%**, so a zoom step or a bigger chat font moves the panel by the same factor while it keeps its
  own density;
- every panel size is expressed in `em`, so one root font size scales the whole interface;
- three tiny top-bar buttons **`A-` / `A` / `A+`** step that multiplier by 0.1 (their tooltips report the
  current percentage), so no shortcut is needed;
- **Ctrl/Cmd `+` / `-`** do the same from the keyboard (the multiplier is stored in `localStorage`), and
  **Ctrl/Cmd `0`** resets it and re-captures the Host baseline;
- a 1 s poll plus observers on the Host's `<html>`/`<body>` attributes pick up changes that emit no event
  the iframe can observe. The panel stays inside 10–22 px so a far-zoomed Host cannot make it unusable.

`lib/web/font-scale.js` holds the arithmetic (`fontTargetOf`, `nextUserScale`, `pxOf`) and
`scripts/font-scale-check.mjs` pins it.

### What exactly gets attached

A loaded conversation reaches the prompt at one of **three fidelity levels**, chosen in the picker
(`正文 / 含工具 / 文件附件`) and remembered on the chip:

| Level | What goes out | Measured on one real 12 783-event session |
|---|---|---|
| `transcript` (default) | user and assistant prose, compaction checkpoints marked; tool traffic and reasoning dropped — DSH's own projection | 183 KB ≈ 85k tokens |
| `tools` | the above plus one line per tool call and a clipped (400-char) result for the newest 12 turns | 65 471 tokens as reported upstream |
| `file` | the whole `full` rendering (every call, 4 000-char results) uploaded through the web API's file route and referenced with `ref_file_ids`, so the model reads it itself | 210 073 tokens as reported upstream |

The row shows `40 / 99 条` when a conversation is longer than the cap: the first number is what goes into
the prompt, the second is how many entries the conversation has. The rule, in order:

1. **Read window.** The last 240 raw events first; if that folds into fewer than 48 entries, the window
   grows to 1200, then 4000, then the whole log. This matters because one agentic turn can be hundreds
   of events — a fixed 240-event tail once returned 3 entries for a 97-entry conversation.
2. **Which events count.** Only `user/message` and `assistant/message` (plus `tool/result` at the two rich
   levels). Reasoning blocks are dropped — they are the model's scratchpad; tool *results* are dropped at
   the prose level; tool *calls* are only counted there.
3. **Folding.** Consecutive assistant events — the steps of one turn — collapse into a single
   `助手:` entry with the prose joined by newlines.
4. **Dropping empties.** A user message with no text, or an entry whose prose and action detail are both
   empty, contributes nothing.
5. **Clipping.** One entry is cut at 4000 characters and marked `…（已截断）`; nothing is lost silently.
6. **The cap.** The newest **40 entries** are kept (`MAX_TURNS`), oldest first. Entries, not raw
   messages: one entry is one user ask or one folded turn.
7. **Budget.** `maxSessionBytes` (default 400 000) per session: the oldest non-checkpoint entries are
   dropped first, then the longest entry is shortened, with a notice. The block attributes record it:
   `entries`, `rendered`, `bytes`, and `omitted` / `omittedBytes` when anything was left out.
8. **Wrapping.** Lines are joined with a blank line and wrapped as
   `<conversation id="…" title="…" mode="…">…</conversation>`, then the whole context is capped by
   `maxContextBytes` with an explicit truncation marker.

At the `file` level the block becomes a short head plus a note that the whole transcript is attached, and
the upload is memoised per session + rendering size. If the upload fails, the inline `tools` rendering is
used instead and the summary marks it `uploadFallback`.

The host reports what it actually sent as a `context` event, so a chip's hint becomes `含工具 · 214 KB`
(or `正文 · 183 KB`, `文件附件 · 26 MB`) after the first request.

> The context is sent on **every** turn while the chip is loaded. `file` mode therefore costs ~200k tokens
> per message; it is the level to pick when fidelity matters more than cost.

## Development

```powershell
node scripts/selftest.mjs              # API parsing, PoW solver, context builder (offline)
node scripts/client-smoke.mjs          # bundle registration + slot injection (fake loader)
node scripts/route-smoke.mjs           # HTTP surface on a fake ctx
node scripts/wasm-fallback-check.mjs   # install without assets: download + reuse the module
node scripts/panel-refs-check.mjs      # panel script reads only declared fields
node scripts/dsh-sessions-check.mjs    # picker titles, previews, hidden empty sessions
node scripts/session-render-check.mjs      # the three fidelity levels
node scripts/composer-bridge-check.mjs # composer insertion tiers (fake DOM)
node scripts/batch-insert-check.mjs        # multi-select ordering, separators, limits
node scripts/ui-copy-check.mjs             # both languages agree, no stray literals
node scripts/attachment-gc-check.mjs       # retention: referenced kept, ours pruned
node scripts/live-check.mjs            # against a running DSH (mints a browser cookie)
node scripts/live-chat.mjs --dsh-session <id>   # real answer, prints text + citations
node scripts/preview.mjs               # static preview server for the panel UI
```

`live-check.mjs` and `live-chat.mjs` read `$DSH_WEB_URL` (or `DSW_ORIGIN`) and mint the browser
cookie from `$DSH_HOME/.credentials.yaml`; they never print secrets.

Reloading after a source change: the row points at a `file://` URL, so Node caches it by URL. Bump
the `?v=` query in the row (or the plugin id) and toggle the plugin off/on — see
[`docs/writing-a-plugin.md`](../../docs/writing-a-plugin.md).

## Privacy

- **What is stored**: one credential record, `deepseek-web-chat/account` in
  `$DSH_HOME/.credentials.yaml`, holding your `userToken`, the masked account info and a device id.
  Nothing else.
- **Where data goes**: requests go to `chat.deepseek.com` only. No telemetry, no analytics, no
  third-party endpoint.
- **What leaves the machine**: your prompt plus whatever context you attach. Attaching a file or a
  DSH conversation sends its **text** to `chat.deepseek.com` — treat that as publishing it; secrets
  inside an attached transcript travel with it.
- **What stays local**: the workspace file list, the sidebar session list and transcripts are read
  by the Host on your machine; only the sliced context you attach is sent.
- **Sign-out** deletes the stored credential (a real delete, not just a cache clear).

## Known limits

- **Private API**: `/api/v0/*` is what the site's own front end calls. It can change without notice;
  fields, headers and the PoW algorithm have all moved before.
- **No tool calling**: the web chat has no function calling, so the panel cannot make DSH read files
  or run commands. It sends a prompt and streams an answer back.
- **Account risk**: it uses your own session. Heavy automated use may trip rate limits or risk
  control; use it as a convenience for yourself, not as a service for others.
- **PoW required**: every completion needs a solved `DeepSeekHashV1` challenge; the solver lives in
  `lib/host/pow.js` but depends on the vendor's wasm blob.

## Third-party assets

`assets/sha3_wasm_bg.wasm` is DeepSeek's own front-end module (from `fe-static.deepseek.com`), used
solely to solve the site's proof-of-work the way the official client does. It is **not** redistributed
here: `.gitignore` keeps `*.wasm` out of commits, and the Host downloads it on first use into
`$DSH_HOME/cache/deepseek-web-chat/` (or you can run `scripts/fetch-wasm.mjs` to keep a copy in the
checkout). Copyright remains with DeepSeek.

## Licence

[MIT](../../LICENSE) for this plugin's own code.
