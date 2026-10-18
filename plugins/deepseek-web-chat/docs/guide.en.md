# Getting a userToken

[中文](guide.zh-CN.md) · English

The panel accepts exactly one credential: a **`userToken`** from `chat.deepseek.com`. It means
"this machine is signed in". Grab it once, paste it once, and later launches stay signed in.
The whole thing takes about 30 seconds.

> Why a manual step: DSH and the web chat share the same account but not the same credential —
> DSH stores a Platform token, which `chat.deepseek.com` rejects (`40003 invalid token`). WeChat QR,
> SMS and Apple sign-in all hand their credential to `chat.deepseek.com`'s own origin, so a
> third-party panel can never receive it. The first hand-off therefore has to be done by a human.

---

## Step 1 · Open the site and sign in

![Step 1: sign in at chat.deepseek.com](../lib/web/guide/step1.svg)

Open <https://chat.deepseek.com/> and sign in the way you normally do — password, SMS code or
WeChat QR all work. Make sure you reach the chat page.

The gate's button **"① Open chat.deepseek.com and sign in"** opens this page for you.

---

## Step 2 · Press F12 to open DevTools

![Step 2: DevTools, Application tab](../lib/web/guide/step2.svg)

- Windows / Linux: `F12` or `Ctrl + Shift + I`
- macOS: `Cmd + Option + I`
- Or right-click the page → **Inspect**

Then pick the **Application** tab at the top.

---

## Step 3 · Expand Local Storage and find `userToken`

![Step 3: the userToken row in Local Storage](../lib/web/guide/step3.svg)

1. In the left tree: **Storage → Local Storage**;
2. Select `https://chat.deepseek.com`;
3. In the table, find the row whose **Key** is `userToken`.

| Key you may see | Meaning |
|---|---|
| `userToken` | ✅ this is the one |
| value looks like `x7Qm2Rb9Lk4Tp8Nv…` | one long string, may contain `+` `/` `=` |

---

## Step 4 · Copy the value and paste it into the panel

![Step 4: paste the token and sign in](../lib/web/guide/step4.svg)

- Double-click the **Value** cell and press `Ctrl + C`;
- or right-click the row → **Copy value**.

Back in the panel's sign-in page, paste it into the box and press **Sign in**.

All three paste shapes are accepted:

```text
x7Qm2Rb9Lk4Tp8Nv...
```
```json
{"value":"x7Qm2Rb9Lk4Tp8Nv...","__version":"0"}
```
```text
userToken: x7Qm2Rb9Lk4Tp8Nv...
```

On success the box clears, the version tag (e.g. `v0.6.0`) appears at the bottom right, and the
top bar shows your masked account.

---

## What it looks like

Any illustration on the sign-in page can be **clicked to enlarge** (click the backdrop or press
`Esc` to close).

| Chinese (400 px sidebar) | English |
|---|---|
| ![sign-in page, Chinese](gate-zh.png) | ![sign-in page, English](gate-en.png) |

Wider panel (620 px):

![wide panel](gate-wide.png)

The enlarged illustration:

![zoom view](gate-zoom.png)

Dark theme:

![dark theme](gate-dark.png)

## FAQ

**"This userToken is invalid or expired"**
You copied something other than the `chat.deepseek.com` entry, or the browser session was signed
out. Redo step 3. If the `userToken` row is gone, sign in on the site again.

**"Signed out — please sign in again"**
The provider rejected the stored token (40002/40003). The plugin **deletes** the local credential
and returns to the sign-in page. Redo the four steps.

**A different machine / a reinstall**
The credential lives in the local DSH credential store (`.credentials.yaml`, `kind: grant`) and is
not synced with your account, so you have to do it once per machine.

**Can this be automated?**
No. Cross-origin access to the site's `localStorage` is impossible, and the desktop shell exposes no
`executeJavaScript` or cookie/storage API to plugins (only `acquire / release / onOpenRequested`).
The password sign-in that existed in `v0.5.0` was removed on purpose.
