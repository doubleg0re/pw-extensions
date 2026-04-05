# pw-extensions

Official extensions for [pw-skill](https://github.com/doubleg0re/pw-skill).

## Extensions

| Extension | Description |
|---|---|
| [`pw-monitor`](./pw-monitor/README.md) | Real-time tab/focus monitor — CDP sidecar, OS-level foreground tracking, `tab:*` + `browser:*` events, GUI dashboard |
| [`pw-ws-server`](./pw-ws-server/README.md) | Generic protocol-driven WebSocket server framework — pushes monitor state to clients via `fs.watch` |
| [`pw-user-action`](./pw-user-action/README.md) | Cross-platform topmost user-action dialog — Tauri/wry renderer, subscribes to monitor state via WebSocket |

See each extension's own README for detailed usage, arguments, and internals.

## Install

Requires [pw-skill](https://github.com/doubleg0re/pw-skill) installed.

```bash
# Install individual extensions using // subdirectory syntax
pw rary get doubleg0re/pw-extensions//pw-monitor
pw rary get doubleg0re/pw-extensions//pw-ws-server
pw rary get doubleg0re/pw-extensions//pw-user-action

# Activate
pw rary put pw-monitor
pw rary put pw-ws-server
pw rary put pw-user-action

# Install with source preserved (needed for rebuilding native binaries)
pw rary get doubleg0re/pw-extensions//pw-user-action --source

# Install and build (runs npm run build in the extension)
pw rary get doubleg0re/pw-extensions//pw-user-action --source --build
```

Or install from a local clone:

```bash
git clone https://github.com/doubleg0re/pw-extensions.git
pw rary get ./pw-extensions//pw-monitor
pw rary put pw-monitor
```

## Usage

Once installed and activated, extensions work automatically:

- **pw-monitor**: Starts a CDP sidecar on `pw launch`. Tracks tab lifecycle,
  OS-level browser window focus, and minimize/restore state. Fires `tab:*`
  and `browser:*` events on monitor state changes. GUI at `pw gui`.
- **pw-ws-server**: `{"action": "ws-server-start"}` in sequence. Serves the
  `monitor` protocol: clients receive a snapshot on connect and live events
  whenever the sidecar updates `monitor-tabs.json`.
- **pw-user-action**: `{"action": "pw-user-action", "prompt": "Approve?",
  "actions": ["yes", "no"]}` in sequence. Spawns a topmost Tauri/wry dialog
  that subscribes to `pw-ws-server`'s monitor protocol and hides itself
  whenever its owning tab isn't active. Works on Windows, macOS, and Linux.

## Architecture

For dialogs that follow the active tab, the three extensions compose into a
real-time event pipeline:

```
Browser (user clicks, minimize, tab switch)
  ↓
pw-monitor sidecar (active-win + CDP polling, 150ms)
  ↓ writes
~/.playwright-state/sessions/<name>/monitor-tabs.json
  ↓ watched via fs.watch (30ms debounce)
pw-ws-server (monitor protocol, port 47831)
  ↓ WebSocket event broadcast
pw-user-action (WS client)
  ↓ stdin JSON
Tauri/wry dialog (show / hide)
```

## Package Structure

Each extension is a self-contained package:

```
pw-monitor/
├── larry.json      # rary manifest (hooks, events, actions)
├── package.json    # npm metadata + dependencies
├── src/            # TypeScript source
├── dist/           # built JS artifacts
└── tests/          # unit tests

pw-user-action/
├── larry.json
├── package.json
├── src/            # TypeScript source
├── dist/           # built JS artifacts
├── tauri/          # Rust source for the webview dialog binary
│   ├── Cargo.toml
│   └── src/main.rs
├── bin/            # platform-specific renderer binary (built via scripts/build-native.mjs)
├── scripts/        # build scripts (cargo → bin/)
└── tests/
```

## Building native binaries

`pw-user-action` ships with a small Tauri/wry dialog renderer written in Rust.

```bash
cd pw-user-action
npm run build
```

The script runs `tsc` and then `cargo build --release` in `tauri/`, copying
the resulting executable to `bin/pw-user-action-renderer[.exe]`. Each target
platform must be built on its own OS (cross-compilation is not configured);
CI or per-platform release artifacts are recommended.

## Requirements

- [pw-skill](https://github.com/doubleg0re/pw-skill)
- Node.js 22+
- `pw-user-action` native build: Rust toolchain (`cargo`) and
  [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
  on Windows (bundled with Windows 11)
- `pw-ws-server` requires `ws` package (auto-installed via npm)
- `pw-monitor` requires `active-win` for OS-level foreground detection
  (auto-installed via npm)

## License

MIT
