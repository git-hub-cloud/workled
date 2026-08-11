# workled MCP Device Setup

This document describes how to connect a workled device so that the workled
skill can control the LED indicator and touch-pad macros, and how to install
the client hooks/plugins that drive `set_agent_state` automatically.

## Prerequisites

- A workled device, powered on.
- Node.js 18+ (for the opencode plugin that communicates with the device).

## First use: connect the device to Wi-Fi

A fresh device broadcasts its own hotspot. Connect your computer to that hotspot:

- A captive portal should open automatically; if not, open `http://192.168.4.1/`
  in a browser.
- Set your home Wi-Fi and enter its password to complete provisioning.
- The device then connects to your home Wi-Fi automatically.

## Home page

Open the device's web page in a browser (device status / provisioning):

```
http://<device-name>.local
```

- `<device-name>` is the name configured when connecting the device (e.g.
  `HomeAnt-1234`); it varies per device.
- On the same LAN you can also use the device's IP address directly (e.g.
  `http://192.168.31.146`).

## MCP endpoint

Once the device is on the same network, its MCP endpoint is:

```
http://<device-name>.local:18791/mcp
```

Add the server to your agent config. For opencode, edit `opencode.json`
(global `~/.config/opencode/opencode.json` or project-level `opencode.json`):

```jsonc
{
  "mcp": {
    "workled": {
      "type": "remote",
      "url": "http://<device-name>.local:18791/mcp",
      "enabled": true
    }
  }
}
```

Other clients follow the same pattern — see `## Installation & Uninstallation`
for per-client config paths and keys.

## Bluetooth pairing (required for macro)

The device appears as a BLE HID keyboard. Pair it with your computer:

- **Windows**: Settings → Bluetooth & devices → Add device → Bluetooth → select `<device-name>`.
- **macOS**: System Settings → Bluetooth → select `<device-name>`.
- **Linux**: `bluetoothctl` → `scan on` → `pair <device-name>` → `trust <device-name>` → `connect <device-name>`.

After pairing, the device stays connected while in range. If it disconnects, re-pair or trigger reconnection.

## Installation & Uninstallation

All clients are installed / uninstalled with `skill-install.mjs`.

`index.js` exports adapters, all with the same entry shape `{id,name,description,register}`:

- `opencodeEntry` — opencode adapter (`register(ctx)` returns hooks; the installed entry wraps it into opencode's plugin factory `async (ctx) => await core.register(ctx)`). **kilo reuses this adapter**: kilo is an opencode fork with identical Event/Hooks types; the kilo entry only changes the module shape (`export default { id, server }`).
- `openclawEntry` — openclaw adapter (`register(api)` hooks `api.on`; the generated entry wraps it with the SDK, installed under `~/.openclaw/plugins/workled/`)
- `piEntry` — pi adapter (`register(pi)` hooks `pi.on`; the generated `.ts` does `export default (pi) => piEntry.register(pi)`)
- CLI hook mode: `node index.js hook [--event <name>]` (unified event→state map; covers agy and hermes shell hooks)

Each client gets a **thin generated entry file** that exposes exactly one adapter, because:

- opencode auto-loads EVERY export of a plugin file as a plugin → the installed file exposes only the `workled` plugin function.
- kilo auto-loads every `.js` in `~/.config/kilo/plugin/` and requires a module descriptor → the installed file does `export default { id: "workled", server: async (ctx) => await core.register(ctx) }`.
- pi loads extensions by **default export** → the installed `.ts` does `export default (pi) => piEntry.register(pi)`.
- openclaw requires a `definePluginEntry`-shaped default export → the installed entry imports the SDK and wraps `openclawEntry`.

### One-click install / uninstall (all clients)

Fully global: every target path is derived from `homedir()`, never from cwd, so the same command runs from any directory on any shell. Every supported client is handled together once you pass `--client all`.

```
node <skill-dir>/skill-install.mjs install --client all        # install to all clients (opencode, kilo, openclaw, agy, hermes, pi, workbuddy)
node <skill-dir>/skill-install.mjs uninstall --client all       # uninstall from all clients
node <skill-dir>/skill-install.mjs install --file <any-instruction-file>   # generic clients (reminder only)
```

> **Targets are explicit.** Both `install` and `uninstall` without `--client`
> fail with the client enum (and `all`) and a hint to pass `--client <name>`
> (your own client) or `--client all`. Omitted never means "all" — that would
> touch / wipe every client's integration by accident.

What every client's install flow does:

1. **Reminder** — writes the marker + reminder block below into the client's instruction file. If the marker is already present, it is not added again.
2. **Client-level hook / plugin / entry** — covers the Enter → first-output gap (the window the agent cannot reach): calls `set_agent_state("thinking")` when the user submits a message.
3. **Uninstall** — removes the marker + reminder block and the hook/entry.

Per-client targets:

| Client   | Hook / plugin target                                   | Instruction file          | Notes |
|----------|--------------------------------------------------------|---------------------------|-------|
| opencode | `~/.config/opencode/plugins/workled/`                | `~/.config/opencode/AGENTS.md` | plugin file only re-exports `workledLed` |
| kilo     | `~/.config/kilo/plugin/workled/`                     | `~/.config/kilo/AGENTS.md` | same plugin API as opencode; `export default { id, server }` module shape |
| openclaw | `~/.openclaw/plugins/workled/` + `openclaw.plugin.json` manifest, registered in `openclaw.json` `plugins.load.paths` + `plugins.entries.workled` | `~/.openclaw/AGENTS.md` | restart the Gateway to load; conversation hooks require `plugins.entries.workled.hooks.allowConversationAccess=true` |
| agy      | `~/.gemini/config/hooks.json` (`workled` key)          | `~/.gemini/AGENTS.md`     | event name read from stdin or `--event` argv |
| hermes   | `hooks:` block in `<hermes-home>/config.yaml` (shell hooks) | `<hermes-home>/AGENTS.md` | home = `$HERMES_HOME` → `%LOCALAPPDATA%\hermes` (Windows) → `~/.hermes` (unix); YAML config; only workled entries are replaced, user hooks are preserved |
| pi       | `~/.pi/agent/extensions/workled.ts`                    | `~/.pi/AGENTS.md`         | default-export wraps `piEntry.register` |
| workbuddy | `~/.workbuddy/mcp.json` (`mcpServers.workled`)         | SKILL.md (loaded by WorkBuddy) | MCP-only; SKILL.md carries the protocol — no hook/plugin/reminder file to manage |
| generic  | none (reminder only)                                   | any `--file`              | clients not listed use manual `set_agent_state` calls only |

### Event mapping per client

- **opencode / kilo** (automatic detection): `session.idle` → `idle`; `session.error` → `error`; `question.asked` → `input`; `question.replied` / `question.rejected` → `thinking`; `permission.asked` → `input`; `permission.replied` → `thinking`. Input tool configurable via `WORKLED_INPUT_TOOLS` (comma-separated, default: `question`).
- **openclaw** (best-effort; verify against a real Gateway): `message_received` → `thinking`; `before_tool_call` (tool in `WORKLED_INPUT_TOOLS`) → `input`; `agent_end` → `idle` (or `error` on a failed run); `session_end` → `idle` fallback.
- **agy** (hook CLI): `PreInvocation`/`PostInvocation` → `thinking`; `PreToolUse`/`PostToolUse` → `input` (only when the payload tool is in `WORKLED_INPUT_TOOLS`); `Stop` → `idle`.
- **hermes** (shell hooks via the same hook CLI): `pre_llm_call` → `thinking`; `post_llm_call` → `idle`; `pre_tool_call` → `input` (only when the tool is in `WORKLED_INPUT_TOOLS`; `post_tool_call` is intentionally NOT registered so a returned input tool does not re-set `input`); `pre_approval_request` → `input`; `post_approval_response` → `thinking`; `on_session_start` → `thinking`; `on_session_end` → `idle`; `subagent_start`/`subagent_stop` → `thinking`.
- **pi** (extension): `agent_start` → `thinking`; `agent_settled` → `idle`; `session_shutdown` → `idle`; `tool_call` (input tools) → `input`; `session_start` → notify.

### Marker line (grep-friendly)

```
<!-- workled -->
> when connected to a workled device via MCP, call `set_agent_state` on every agent state transition:
> - `set_agent_state("thinking")` while working
> - `set_agent_state("idle")` when the turn finishes; the user can continue with a new question
> - `set_agent_state("input")` when you need the user to confirm a choice, pick an option, or reply — INCLUDING plain-text choice lists and built-in client modals (hermes destructive-command panel, clarify, prompt_toolkit confirmations). Client hooks only fire on tool / LLM / approval events; they do NOT see these. Call it yourself before rendering the options.
> - `set_agent_state("error")` on errors
```

## Installing for one client

`skill-install.mjs install` / `uninstall` both **require** an explicit target:
`--client <name>` (opencode, kilo, openclaw, agy, hermes, pi, workbuddy) for one
client, or `--client all` for every client. `index.js status` accepts the same
optional `--client <name>` filter; default is **all clients**.

```
node <skill-dir>/skill-install.mjs install --client opencode
node <skill-dir>/skill-install.mjs uninstall --client opencode
node <skill-dir>/skill-install.mjs uninstall --client all
node <skill-dir>/index.js status --client opencode
```

> **Agent-facing guidance:** always pass your own client name —
> `node <skill-dir>/skill-install.mjs install|uninstall --client <your-client>`.
> A bare `install` / `uninstall` errors with the client enum (opencode, kilo,
> openclaw, agy, hermes, pi, workbuddy, all); deliberately pass `--client all`
> only when you intend to apply the operation to every client.

After installing, run `node <skill-dir>/index.js status` and surface the JSON
`hint` to the user. A `hint` of "No `workled` server configured" means the
client's MCP is not set up — guide the user through the MCP endpoint
above.

## Verify

After the device is reachable and the opencode plugin is loaded, trigger an LED
state change:

```
set_agent_state("idle")
```

The LED should respond. If it does not, see Troubleshooting below.

## Troubleshooting

Run the diagnostic command first when the LED does not respond; it prints a
single JSON object describing the first `workled` MCP server found and its
reachability. Exit code is 0 when a workled config exists and is reachable,
1 otherwise:

```
node <skill-dir>/index.js status
```

The command scans the MCP config of every client (opencode global and project,
agy/gemini, openclaw, pi, workbuddy), takes the first server named `workled`
(`WORKLED_MCP_URL` override wins), and checks reachability via an MCP
`initialize` handshake — tools are not probed. Fields:

- `WORKLED_MCP_URL` — the override value, or `null`
- `workled` — `{ client, enabled, url, reachable, error? }`, or `null` when no
  `workled` server is configured
- `hint` — a concrete next step for the current state
- `ok` / `exitCode` — success flag and process exit code

- **Device not on the network yet** — connect to the device hotspot first and
  complete Wi-Fi provisioning (see "First use" above). After provisioning the
  device joins your home Wi-Fi automatically.
- **Device unreachable** — make sure the device is powered on and that your
  computer is on the same Wi-Fi network as the device.
- **mDNS name not resolving** — the device name must match the one configured
  for the device; it varies per device. When in doubt, use the device's IP
  address instead of the `.local` name.
- **workled configured but disabled** — `workled.enabled` is `false`; enable it
  in your agent config or set `WORKLED_MCP_URL`.
- **Device reachable but the LED stays off** — the strip brightness may be 0.
  Run `set_brightness("128")`, or use the device's manual on/off switch.
- **No MCP config found at all** — neither `WORKLED_MCP_URL` nor any config
  source declares the server. Add it under `mcp` in your agent config (see
  "MCP endpoint" above) or set the environment variable.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WORKLED_MCP_URL` | Override the MCP server URL directly. |
