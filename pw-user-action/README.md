# pw-user-action

Cross-platform topmost user-action dialog for `pw-skill` sequences. When a
flow needs the user to click a button — approve/cancel, pick a variant, ack
a challenge — `pw-user-action` pops a small Tauri/wry webview, waits for the
click, and returns the chosen action.

## Features

- **Native webview dialog** — Tauri/wry renders an HTML dialog in the OS
  webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux).
  ~500 KB stripped binary.
- **Follows the active tab** — subscribes to `pw-monitor` state via
  `pw-ws-server` and hides itself whenever the owning tab isn't in the OS
  foreground. Reappears when the user returns.
- **Topmost / always-on-top** with dialog-focus retention (no flicker when
  the user clicks the dialog).
- **Custom title + icon** per invocation.

## Usage

In a `pw sequence` flow:

```json
{
  "action": "pw-user-action",
  "title": "Image Generation — Approval",
  "prompt": "AI가 이미지를 생성했습니다. 저장할까요?",
  "actions": ["save", "regenerate", "cancel"]
}
```

### Arguments

| Field   | Type       | Description                                                                 |
|---------|------------|-----------------------------------------------------------------------------|
| `title` | `string`   | Window title. Default: `"pw-user-action"`.                                  |
| `prompt`| `string`   | Message shown in the dialog body.                                           |
| `actions`| `string[]`| Button labels. The clicked label is returned as `result.action`.            |
| `focus` | `string`   | (Optional) CSS selector to click on the page before opening the dialog.     |
| `idle`  | `number`   | (Optional) ms to wait after `focus` before showing the dialog.              |

### Return shape

```json
{
  "waited": "pw-user-action",
  "action": "save",
  "prompt": "...",
  "renderer": "native-dialog",
  "session": "my-session",
  "tabId": 1,
  "submittedAt": "2026-04-05T12:34:56.789Z"
}
```

## Dependencies

- **`pw-monitor`** — writes the monitor state file that tracks active tab,
  browser focus, and window minimize.
- **`pw-ws-server`** — watches the monitor state file via `fs.watch` and
  pushes events over WebSocket so the dialog reacts in real time.

If `pw-ws-server` isn't running the dialog will try to spawn it automatically.
If that fails the dialog falls back to the initial visibility and stays put.

## Architecture

```
  parent (pw sequence)
    │
    │  spawn(pw-user-action-renderer) + stdin/stdout JSON
    ↓
  Tauri/wry dialog ──────────────────►  user click
    ▲                                           │
    │  {"type":"visible",...}                  │
    │                                  {"type":"clicked",...}
    │                                           │
  native-dialog.ts                              ↓
    │                                       return action
    │  WebSocket (monitor protocol)
    ↓
  pw-ws-server  ◄── fs.watch ── ~/.playwright-state/sessions/{name}/monitor-tabs.json
                                                ▲
                                                │  150ms poll (active-win, CDP)
                                          pw-monitor sidecar
```

### stdin/stdout IPC (renderer protocol)

The Tauri binary speaks line-delimited JSON on its stdio so the parent can
drive it without touching the filesystem.

Parent → renderer (stdin):

| type      | payload                                                                 |
|-----------|-------------------------------------------------------------------------|
| `init`    | `{id, prompt, actions, title?}` — must be the first message            |
| `visible` | `{value: boolean}` — sent on every browser focus/visibility change     |
| `update`  | `{prompt, actions, title?}` — replace dialog contents in place         |
| `exit`    | `{}` — graceful shutdown                                                |

Renderer → parent (stdout):

| type      | payload                                                                 |
|-----------|-------------------------------------------------------------------------|
| `ready`   | `{}` — sent once after the window is built                             |
| `clicked` | `{action, submittedAt}` — user clicked a button, renderer exits        |

## Building the renderer binary

The Tauri source lives in `tauri/`. Run `npm run build` in the extension:

```bash
cd pw-user-action
npm run build
```

This runs `tsc` and then `cargo build --release` in `tauri/`, copying the
result to `bin/pw-user-action-renderer[.exe]`.

### Requirements

- **Rust toolchain** (`cargo`) — install via [rustup](https://rustup.rs/).
- **Windows:** WebView2 Runtime (bundled with Windows 11, otherwise install
  from Microsoft).
- **macOS:** No extra runtime. Binary is unsigned; users must right-click →
  Open or run `xattr -d com.apple.quarantine` on first launch.
- **Linux:** WebKitGTK 4.1 (`libwebkit2gtk-4.1-dev` on Debian/Ubuntu).

Binaries are built per-OS and are not cross-compiled. CI or per-platform
release artifacts are recommended for distribution.

## License

MIT
