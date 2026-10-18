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
| **Bilingual sign-in** | The pre-login page is Chinese/English with a four-step illustrated guide. |

## Requirements

- DSH with the **desktop** profile (the sidebar tab needs `@deepseek-ai/dsh-client-ui-sidebar-right`).
- A `chat.deepseek.com` account.

## Install

### 1. Clone

```powershell
git clone https://github.com/vector-c-li/dsh-plugins.git "$env:USERPROFILE\dsh-plugins"
```

```bash
git clone https://github.com/vector-c-li/dsh-plugins.git ~/dsh-plugins
```

The plugin lives at `<clone>/plugins/deepseek-web-chat`.

### 2. Fetch the PoW module

The plugin ships without the vendor's WebAssembly blob (see [Third-party assets](#third-party-assets)):

```powershell
node plugins\deepseek-web-chat\scripts\fetch-wasm.mjs
```

It downloads `assets/sha3_wasm_bg.wasm` (~26 KB) from `fe-static.deepseek.com`. Re-run it if the
file is missing — every request to the web chat needs it to solve the site's proof-of-work.

### 3. Register it with your DSH profile

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

### 4. Verify, then sign in

- Open `http://127.0.0.1:<dsh port>/deepseek-web/` — you should get the sign-in page;
- Or refresh DSH and open the **DeepSeek Chat** tab from the sidebar `+` menu.

Sign-in needs a `userToken`; the panel walks you through it in four illustrated steps, and
[`docs/guide.en.md`](docs/guide.en.md) has the long version.

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

## Development

```powershell
node scripts/selftest.mjs      # API parsing, PoW solver, context builder (offline)
node scripts/client-smoke.mjs  # bundle registration + slot injection (fake loader)
node scripts/route-smoke.mjs   # HTTP surface on a fake ctx
node scripts/live-check.mjs    # against a running DSH (mints a browser cookie)
node scripts/live-chat.mjs --dsh-session <id>   # real answer, prints text + citations
node scripts/preview.mjs       # static preview server for the panel UI
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
here: `scripts/fetch-wasm.mjs` downloads it into your checkout and `.gitignore` keeps it out of
commits. Copyright remains with DeepSeek.

## Licence

[MIT](../../LICENSE) for this plugin's own code.
