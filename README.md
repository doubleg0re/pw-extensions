# pw-extensions

Official extensions for [pw-skill](https://github.com/doubleg0re/pw-skill).

## Extensions

| Extension | Description |
|---|---|
| `pw-monitor` | Real-time tab monitor — CDP WebSocket sidecar, `tab:*` events, GUI dashboard |
| `pw-ws-server` | Generic protocol-driven WebSocket server framework |
| `pw-user-action` | User-action overlay — navigation-resilient, persistent state, native renderer ready |

## Install

```bash
# Install an extension
pw rary get doubleg0re/pw-extensions/extensions/pw-monitor
pw rary put pw-monitor

# Or clone the whole repo and install from local path
git clone https://github.com/doubleg0re/pw-extensions.git
pw rary get ./pw-extensions/extensions/pw-monitor
pw rary put pw-monitor
```

## Usage

Once installed and activated, extensions work automatically:

- **pw-monitor**: Starts sidecar on `pw launch`, syncs tabs on every command
- **pw-ws-server**: `{"action": "ws-server-start"}` in sequence to start WS server
- **pw-user-action**: `{"action": "pw-user-action", "prompt": "Approve?", "actions": ["yes", "no"]}` in sequence

## Requirements

- [pw-skill](https://github.com/doubleg0re/pw-skill) installed
- Node.js 22+
- `pw-ws-server` requires `ws` package (auto-installed via `npm install` in extension dir)

## License

MIT
