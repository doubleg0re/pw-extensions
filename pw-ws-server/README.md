# pw-ws-server

Generic protocol-driven WebSocket server framework for `pw-skill`
extensions. Define a protocol in JSON, drop handler scripts next to it, and
`pw-ws-server` spawns a detached server that routes messages, pushes live
events from a source adapter, and cleans up when the session dies.

## Features

- **Protocol-as-JSON** — schema, inbound/outbound messages, lifecycle hooks
  declared in a single JSON file.
- **Source adapters** — pluggable state providers. The built-in `pw-monitor`
  adapter watches `monitor-tabs.json` via `fs.watch` (30 ms debounce) and
  pushes snapshots to all connected clients.
- **Detached server** — spawned via `ws-server-start` action, writes
  `ws-server.json` metadata so clients can discover the URL.
- **Session-scoped** — one server per `pw-skill` session; auto-exits when
  the owning session process dies.

## Actions

| Action              | Description                                         |
|---------------------|-----------------------------------------------------|
| `ws-server-start`   | Spawn the WebSocket server for this session.        |
| `ws-server-stop`    | SIGTERM the running server.                         |
| `ws-server-status`  | Read `ws-server.json` metadata, check liveness.     |

### Usage in a sequence

```json
{
  "action": "ws-server-start",
  "port": 47831,
  "protocol": "monitor"
}
```

Defaults: `port=47831`, `host=127.0.0.1`, `protocol=monitor`.

## Built-in monitor protocol

The shipped `monitor` protocol streams `pw-monitor`'s state to clients.

**Outbound** (server → client):

```jsonc
// Sent once on connect
{
  "type": "snapshot",
  "source": "monitor",
  "session": "my-session",
  "data": { /* full MonitorState */ },
  "timestamp": "..."
}

// Sent on every monitor-tabs.json change
{
  "type": "event",
  "source": "monitor",
  "session": "my-session",
  "data": { /* full MonitorState */ },
  "timestamp": "..."
}
```

**Inbound** (client → server):

```jsonc
{ "type": "ping", "message": "hello" }
// → { "type": "pong", "message": "hello", "timestamp": "..." }
```

## Client discovery

Servers write metadata to:

```
~/.playwright-state/sessions/{name}/ws-server.json
```

```jsonc
{
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 47831,
  "protocol": "monitor",
  "session": "my-session",
  "startedAt": "..."
}
```

Clients read this file, verify `pid` is alive, and connect to
`ws://{host}:{port}`.

## Defining a new protocol

1. Create `protocols/<name>.json`:

```jsonc
{
  "name": "myprotocol",
  "version": "0.1.0",
  "outbound": { "update": {} },
  "inbound": {
    "doThing": {
      "handler": "../handlers/myprotocol/do-thing.ts",
      "schema": {
        "type": "object",
        "required": ["payload"],
        "properties": { "payload": { "type": "string" } }
      }
    }
  },
  "hooks": {
    "onConnect": "../handlers/myprotocol/on-connect.ts"
  }
}
```

2. Create handler scripts in `handlers/myprotocol/`. Each exports a default
   async function `(msg, ctx) => void`.

3. Start the server with `{"action": "ws-server-start", "protocol": "myprotocol"}`.

## Source adapters

A source adapter is a module in `src/sources/<name>.ts` that exports an
object with `subscribe(sessionName, emit)`. It's invoked if a protocol sets
`source.adapter` and `source.watch: true`. The returned unsubscribe function
is called on server shutdown.

Example: `pw-monitor` adapter (`src/sources/pw-monitor.ts`) watches
`monitor-tabs.json`, `session.json`, and `pending-actions.json` via
`fs.watch`, debounces 30 ms, and emits a fresh snapshot.

## License

MIT
