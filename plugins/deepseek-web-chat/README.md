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

`v0.5.3` and later log a readable warning for this case instead of failing activation.

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
node scripts/selftest.mjs              # API parsing, PoW solver, context builder (offline)
node scripts/client-smoke.mjs          # bundle registration + slot injection (fake loader)
node scripts/route-smoke.mjs           # HTTP surface on a fake ctx
node scripts/wasm-fallback-check.mjs   # install without assets: download + reuse the module
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
