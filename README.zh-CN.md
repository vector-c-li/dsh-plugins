# dsh-plugins

中文 · [English](README.md)

给 **[DSH](https://github.com/deepseek-ai)**（DeepSeek Harness）写的插件 —— 以及我写第一个插件时
最想看到的那份说明。

| 插件 | 作用 |
|---|---|
| [`plugins/deepseek-web-chat`](plugins/deepseek-web-chat) | 在 DSH 右侧边栏里加一个 chat.deepseek.com 面板：不离开 DSH 就能问网页版，还能把工作区文件或一条 DSH 会话当作上下文带上。用你自己的账号，不需要 API Key。 |

![登录页](plugins/deepseek-web-chat/docs/gate-zh.png)

## 为什么要单独建一个插件仓库

DSH 插件体量不大，但结构不直观：它有一个 **Host 半**（Cordis 插件，掌管服务、HTTP 路由和凭据）
和一个 **浏览器半**（DSH Web UI 注册成插槽的 bundle），另外还需要一份 bundle 补丁让加载器知道
Host 行。这个仓库把这些部分放在一处，并配好可复用的目录结构、测试和热重载流程：

```
dsh-plugins/
├─ README.md / README.zh-CN.md      本页
├─ LICENSE                          MIT
├─ docs/
│  ├─ writing-a-plugin.md           两半怎么配合
│  └─ writing-a-plugin.zh-CN.md
└─ plugins/
   └─ deepseek-web-chat/
      ├─ package.json               dsh.bundle / dsh.client 声明
      ├─ cordis.patch.yml           bundle 层：插入 Host 行
      ├─ lib/                       Host（index.js、host/*）+ 客户端 bundle（client.js）+ Web UI
      ├─ scripts/                   自测、冒烟测试、预览服务
      └─ docs/                      中英双语用户指南与截图
```

## 快速开始

在 DSH 里打开 **插件 → 添加插件**，粘贴这一行：

```
github:vector-c-li/dsh-plugins#path:/plugins/deepseek-web-chat
```

DSH 会用 pnpm 装好并把它作为组合包启用；刷新页面（侧栏标签页没出现就重启一次），
从 `+` 菜单打开 **DeepSeek Chat**。工作量证明模块会在首次使用时自动下载，不需要额外准备。

想用本地检出（改代码开发）就先 `git clone`，再按
[`plugins/deepseek-web-chat/README.zh-CN.md`](plugins/deepseek-web-chat/README.zh-CN.md#安装)（中文）或
[`README.md`](plugins/deepseek-web-chat/README.md#install)（English）里的步骤注册。

## 建议的阅读顺序

1. [`docs/writing-a-plugin.md`](docs/writing-a-plugin.zh-CN.md) —— Host 半、浏览器半、bundle 补丁、
   让热重载成立的模块缓存技巧，以及本仓库遵循的测试分层。
2. [`plugins/deepseek-web-chat`](plugins/deepseek-web-chat) —— 一个完整的样例：凭据、HTTP 路由、
   SSE 流、WebAssembly 依赖、拖拽上下文、双语界面。
3. [`plugins/deepseek-web-chat/docs/guide.zh-CN.md`](plugins/deepseek-web-chat/docs/guide.zh-CN.md) ——
   面向用户的指南。

## 约定

- **一个插件一个目录**，放在 `plugins/` 下，目录名与包名一致（`dsh-<name>`）。
- **文档双语**：所有面向人的文档都有 `X.md`（English）与 `X.zh-CN.md`（中文），开头带语言切换行。
- **git 里不放个人数据**：不放绝对家目录路径、账号标识、token，也不放真实账号的截图。
  检查清单见写作指南。
- **下载物不进库**：厂商二进制（例如工作量证明模块）由脚本下载，并写进 `.gitignore`。

## 隐私

这些插件跑在你的 DSH 里，用**你自己的**凭证访问第三方服务。本仓库不收集任何东西：
没有遥测，也不经过我的任何服务器。每个插件的 README 都有「隐私」一节，写清楚它存了什么、
什么会离开你的机器 —— 把文件或对话当上下文附上去之前，请先读那一节。

## 许可

本仓库代码使用 [MIT](LICENSE)。第三方内容（DeepSeek 的工作量证明模块、chat.deepseek.com 接口、
商标）见 [`NOTICE.md`](NOTICE.md)。
