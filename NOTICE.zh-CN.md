# 第三方声明

[English](NOTICE.md) · 中文

本仓库代码适用 [`LICENSE`](LICENSE) 里的 MIT 许可。

## DeepSeek 前端资源（本仓库不分发）

`plugins/deepseek-web-chat` 需要 DeepSeek 的 WebAssembly 工作量证明模块
`plugins/deepseek-web-chat/assets/sha3_wasm_bg.wasm`。它**不在**本仓库里：

- 它是 DeepSeek 自己的前端资源，由 `fe-static.deepseek.com` 提供；
- `plugins/deepseek-web-chat/scripts/fetch-wasm.mjs` 会把它下载到使用者自己的本地检出；
- `.gitignore` 用 `*.wasm` 把它挡在所有提交之外。

该模块的版权归 DeepSeek。下载到本地执行，只是为了按官方 Web 客户端的算法解
`DeepSeekHashV1` 挑战。

## chat.deepseek.com 接口

插件调用 chat.deepseek.com 的私有 Web 接口（`/api/v0/*`）。该接口没有面向第三方开放，也没有
相应授权，随时可能变化。使用本插件意味着你以自己的账号接受该站点的服务条款。

## 商标

"DeepSeek" 名称与 DeepSeek 标识归其权利人所有。本项目是非官方集成，与 DeepSeek 无隶属关系，
也未获其背书。
