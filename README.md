# pw-extensions

Official extensions for [pw-skill](https://github.com/doubleg0re/pw-skill).

## Extensions

| Extension | Description |
|---|---|
| `pw-monitor` | Real-time tab monitor — CDP WebSocket sidecar, `tab:*` events, GUI dashboard |
| `pw-ws-server` | Generic protocol-driven WebSocket server framework |
| `pw-user-action` | Navigation-resilient user-action overlay — persistent state, native renderer ready |

## Install

Requires [pw-skill](https://github.com/doubleg0re/pw-skill) installed.

```bash
# Install individual extensions using // subdirectory syntax
pw rary get doubleg0re/pw-extensions//pw-monitor
pw rary get doubleg0re/pw-extensions//pw-user-action
pw rary get doubleg0re/pw-extensions//pw-ws-server

# Activate
pw rary put pw-monitor
pw rary put pw-user-action
pw rary put pw-ws-server

# Install with source preserved
pw rary get doubleg0re/pw-extensions//pw-monitor --source

# Install and build
pw rary get doubleg0re/pw-extensions//pw-monitor --source --build
```

Or install from a local clone:

```bash
git clone https://github.com/doubleg0re/pw-extensions.git
pw rary get ./pw-extensions//pw-monitor
pw rary put pw-monitor
```

## Usage

Once installed and activated, extensions work automatically:

- **pw-monitor**: Starts CDP sidecar on `pw launch`, syncs tabs in real-time, GUI at `pw gui`
- **pw-user-action**: `{"action": "pw-user-action", "prompt": "Approve?", "actions": ["yes", "no"]}` in sequence
- **pw-ws-server**: `{"action": "ws-server-start"}` in sequence to start WebSocket server

## Package Structure

Each extension is a self-contained package:

```
pw-monitor/
├── larry.json      # rary manifest (hooks, events, actions)
├── package.json    # npm metadata + dependencies
├── src/            # source code
└── tests/          # unit tests
```

## Requirements

- [pw-skill](https://github.com/doubleg0re/pw-skill)
- Node.js 22+
- `pw-ws-server` requires `ws` package (auto-installed via npm)

## License

MIT
