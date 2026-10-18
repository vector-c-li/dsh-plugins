# Third-party notices

English · [中文](NOTICE.zh-CN.md)

The MIT licence in [`LICENSE`](LICENSE) covers the code in this repository.

## DeepSeek front-end asset (not distributed here)

`plugins/deepseek-web-chat` needs DeepSeek's WebAssembly proof-of-work module at
`plugins/deepseek-web-chat/assets/sha3_wasm_bg.wasm`. It is **not** part of this repository:

- it is DeepSeek's own front-end asset, served from `fe-static.deepseek.com`;
- `plugins/deepseek-web-chat/scripts/fetch-wasm.mjs` downloads it into the user's own checkout;
- `.gitignore` keeps `*.wasm` out of every commit.

Copyright in that module remains with DeepSeek. It is fetched and executed locally only to solve the
site's `DeepSeekHashV1` challenge the same way the official web client does.

## chat.deepseek.com API

The plugin talks to chat.deepseek.com's private web API (`/api/v0/*`). That interface is not
documented or licensed for third-party use; it can change at any time. Using this plugin means
accepting the site's own terms of service for your account.

## Other trademarks

"DeepSeek" and the DeepSeek logo are trademarks of their owner. This project is an unofficial
integration and is not affiliated with or endorsed by DeepSeek.
