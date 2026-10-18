# dsh-plugins

English · [中文](README.zh-CN.md)

Plugins for **[DSH](https://github.com/deepseek-ai)** (DeepSeek Harness) — and the notes I wish I had
when writing the first one.

| Plugin | What it does |
|---|---|
| [`plugins/deepseek-web-chat`](plugins/deepseek-web-chat) | A chat.deepseek.com panel in DSH's right sidebar: ask the web chat from inside the app, with workspace files or a DSH conversation attached as context. Uses your own account, no API key. |

![sign-in page](plugins/deepseek-web-chat/docs/gate-zh.png)

## Why a repo for plugins

A DSH plugin is small but not obvious: it has a **Host half** (a Cordis plugin that owns services,
HTTP routes and credentials) and a **browser half** (a bundle the DSH web UI registers as a slot),
plus a bundle patch so the loader knows the Host row. This repo keeps those pieces in one place with a
repeatable layout, tests and a reload workflow:

```
dsh-plugins/
├─ README.md / README.zh-CN.md      this page
├─ LICENSE                          MIT
├─ docs/
│  ├─ writing-a-plugin.md           how the two halves fit together
│  └─ writing-a-plugin.zh-CN.md
└─ plugins/
   └─ deepseek-web-chat/
      ├─ package.json               dsh.bundle / dsh.client declarations
      ├─ cordis.patch.yml           bundle layer: insert the Host row
      ├─ lib/                       Host (index.js, host/*) + client bundle (client.js) + web UI
      ├─ scripts/                   self-tests, smoke tests, preview server
      └─ docs/                      bilingual user guide and screenshots
```

## Quick start

Open **Plugins → Add plugin** in DSH and paste this one line:

```
github:vector-c-li/dsh-plugins#path:/plugins/deepseek-web-chat
```

DSH installs it with pnpm and enables it as a bundle; refresh the page (restart once if the sidebar
tab is missing) and open **DeepSeek Chat** from the `+` menu. The proof-of-work module is fetched on
first use, so there is nothing else to download.

Prefer a local checkout (for development)? `git clone` the repo and follow
[`plugins/deepseek-web-chat/README.md`](plugins/deepseek-web-chat/README.md#install) (English) or
[`README.zh-CN.md`](plugins/deepseek-web-chat/README.zh-CN.md#安装) (中文).

## Reading order

1. [`docs/writing-a-plugin.md`](docs/writing-a-plugin.md) — Host half, browser half, bundle patch,
   the module-cache trick that makes hot reload work, and the testing pyramid this repo follows.
2. [`plugins/deepseek-web-chat`](plugins/deepseek-web-chat) — a complete worked example: credentials,
   an HTTP route, an SSE stream, a WebAssembly dependency, drag-and-drop context, bilingual UI.
3. [`plugins/deepseek-web-chat/docs/guide.en.md`](plugins/deepseek-web-chat/docs/guide.en.md) — the
   user-facing guide.

## Conventions

- **One plugin per directory** under `plugins/`, named after its package (`dsh-<name>`).
- **Bilingual docs**: every human-facing document exists as `X.md` (English) and `X.zh-CN.md`
  (中文), each starting with a language switcher line.
- **No personal data in git**: no absolute home paths, no account identifiers, no tokens, no
  screenshots of a real account. See the checklist in the writing guide.
- **Downloaded assets stay out**: vendor blobs (like the proof-of-work module) are fetched by a
  script and listed in `.gitignore`.

## Privacy

These plugins run inside your DSH and talk to third-party services with **your** credentials. Nothing
is collected by this repository: there is no telemetry, and no server of mine is involved. Each
plugin's README has a *Privacy* section that states exactly what it stores and what leaves your
machine — read it before attaching files or conversations as context.

## Licence

[MIT](LICENSE) for the code here. Third-party material (DeepSeek's proof-of-work module, the
chat.deepseek.com API, trademarks) is covered by [`NOTICE.md`](NOTICE.md).
