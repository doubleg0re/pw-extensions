# pw-monitor

Real-time tab and focus monitor for `pw-skill`. Tracks browser tabs via the
Chrome DevTools Protocol, detects OS-level foreground window changes, and
exposes the state as live events plus a JSON state file that other
extensions (`pw-user-action`, `pw-ws-server`) can subscribe to.

## Features

- **Tab lifecycle** — `tab:created`, `tab:navigated`, `tab:activated`,
  `tab:deactivated`, `tab:closed` events via CDP `Target.*` events.
- **OS foreground tracking** — uses [`active-win`](https://www.npmjs.com/package/active-win)
  to read the real foreground window, then walks the process tree (wmic on
  Windows, `ps` on macOS/Linux) to distinguish our Playwright Chromium from
  other Chromium-based browsers sharing the same executable name.
- **Multi-window support** — matches the OS foreground window's bounds
  against each tab's CDP window bounds (`Browser.getWindowBounds`), so
  dragging a tab to a new window is handled correctly.
- **Minimize detection** — polls `Browser.getWindowBounds` for
  `windowState !== 'minimized'`.
- **Browser events** — `browser:focused`, `browser:blurred`,
  `browser:visible`, `browser:hidden` emitted when state changes between
  `pw` command invocations.
- **GUI dashboard** — optional web UI at `pw gui`.

## Usage

After installing and activating, `pw-monitor` runs automatically whenever
you `pw launch`. A detached sidecar process connects to the browser's CDP
endpoint and writes state to:

```
~/.playwright-state/sessions/{name}/monitor-tabs.json
```

Other extensions consume this file directly or via `pw-ws-server`.

### State file fields

```jsonc
{
  "nextId": 3,
  "tabs": [
    {
      "tabId": 1,
      "cdpTargetId": "...",
      "url": "https://example.com/",
      "title": "Example Domain",
      "createdAt": "...",
      "lastSeenAt": "..."
    }
  ],
  "activeTabId": 1,
  "browserVisible": true,   // window is not minimized
  "browserFocused": true,   // OS foreground window belongs to our browser
  "sidecarPid": 12345
}
```

## Events

Tab events (emitted from `load-hook` on every `pw` command, backed by CDP
polling):

| Event             | Payload                                                |
|-------------------|--------------------------------------------------------|
| `tab:created`     | `{session, tabId, url, title, timestamp}`             |
| `tab:navigated`   | `{session, tabId, url, title, timestamp}`             |
| `tab:activated`   | `{session, tabId, url, title, timestamp}`             |
| `tab:deactivated` | `{session, tabId, url, title, timestamp}`             |
| `tab:closed`      | `{session, tabId, url, title, timestamp}`             |

Browser events (emitted when focus/visibility state transitions):

| Event              | Payload                         |
|--------------------|---------------------------------|
| `browser:focused`  | `{session, timestamp}`          |
| `browser:blurred`  | `{session, timestamp}`          |
| `browser:visible`  | `{session, timestamp}`          |
| `browser:hidden`   | `{session, timestamp}`          |

## Sidecar

`monitor-sidecar.ts` is spawned as a detached child on `pw launch`. It:

1. Connects to the browser's CDP WebSocket.
2. Enables `Target.setDiscoverTargets` to track tab lifecycle.
3. Polls `/json`, `Browser.getWindowBounds`, and `active-win` every 150 ms.
4. Walks the Chromium process tree to verify the foreground window belongs
   to *this* browser (not Brave/Chrome/Edge running side-by-side).
5. Matches the foreground window's bounds against each tab's CDP window
   bounds to find which tab is really in focus.
6. Persists state to `monitor-tabs.json` on every change.

Sidecar stderr goes to `~/.playwright-state/sessions/{name}/sidecar.log` for
debugging.

## Dependencies

- [`active-win`](https://www.npmjs.com/package/active-win) — OS foreground
  window query (cross-platform).

## License

MIT
