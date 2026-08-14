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

## Device Home page

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

## Bluetooth pairing (required for macro)

The device appears as a BLE HID keyboard. Its name starts with `HomeAnt` or `workled`. Pair it with your computer:

- **Windows**: Settings → Bluetooth & devices → Add device → Bluetooth → select the device whose name starts with `HomeAnt` or `workled`.
- **macOS**: System Settings → Bluetooth → select the device whose name starts with `HomeAnt` or `workled`.
- **Linux**: `bluetoothctl` → `scan on` → look for a device whose name starts with `HomeAnt` or `workled` → `pair <device-name>` → `trust <device-name>` → `connect <device-name>`.

After pairing, the device stays connected while in range. If it disconnects, re-pair or trigger reconnection.

## Installation & Uninstallation

### Install the skill

Choose one of the following methods to install the skill locally.

#### Method 1 — Agent-based install (recommended)

If your agent client provides a skill installer that accepts a remote URL,
point it at the repository:

```
https://github.com/git-hub-cloud/workled
```

#### Method 2 — git clone (manual)

Clone the repository into a directory your client scans for `skills/*/SKILL.md`.
opencode scans the paths below automatically:

```bash
git clone https://github.com/git-hub-cloud/workled.git ~/.agents/skills/workled
```

Keep up to date:

```bash
git -C ~/.agents/skills/workled pull
```

### Client integration

Fully global: every target path is derived from `homedir()`, never from cwd, so
the same command runs from any directory on any shell. Both `install` and
`uninstall` **require** an explicit target: `--client <name>` (opencode, kilo,
openclaw, agy, hermes, pi, workbuddy) for one client, or `--client all` for
every client. `--file` targets a single instruction file (reminder only).
`index.js status` accepts the same optional `--client <name>` filter; default
is **all clients**.

```
node <skill-dir>/skill-install.mjs install|uninstall --client <name>|all
node <skill-dir>/skill-install.mjs install|uninstall --file <any-instruction-file>   # generic clients (reminder only)
node <skill-dir>/skill-install.mjs --help
node <skill-dir>/index.js status [--client <name>]    # filter optional; default all
```

Examples:

```
node <skill-dir>/skill-install.mjs install --client opencode
node <skill-dir>/skill-install.mjs uninstall --client opencode
node <skill-dir>/skill-install.mjs install --client all
node <skill-dir>/skill-install.mjs uninstall --client all
node <skill-dir>/index.js status --client opencode
```

> **Targets are explicit.** A bare `install` / `uninstall` (no `--client`)
> errors with the client enum and a hint to pass `--client <name>` — your own
> client — or `--client all`. Omitted never means "all"; deliberately pass
> `--client all` only when you intend to apply the operation to every client.

What every client's install flow does:

1. **Reminder** — writes the marker + reminder block below into the client's instruction file. If the marker is already present, it is not added again.
2. **Client-level hook / plugin / entry** — covers the Enter → first-output gap (the window the agent cannot reach): calls `set_agent_state("thinking")` when the user submits a message.
3. **MCP entry** — registers the `workled` server in the client's MCP config (opencode/kilo/openclaw/agy/pi/workbuddy register it; hermes uses a YAML block).
4. **Uninstall** — removes the marker + reminder block, the hook/entry, and the MCP entry. Everything else in the config files is preserved verbatim.

### Event mapping per client

- **opencode / kilo** (automatic detection): `session.idle` → `idle`; `session.error` → `error`; `question.asked` → `input`; `question.replied` / `question.rejected` → `thinking`; `permission.asked` → `input`; `permission.replied` → `thinking`. Input tools are detected by a fixed `question` substring match (e.g. `AskUserQuestion`).
- **openclaw** (best-effort; verify against a real Gateway): `message_received` → `thinking`; `before_tool_call` (tool name matches `question`) → `input`; `agent_end` → `idle` (or `error` on a failed run); `session_end` → `idle` fallback.
- **agy** (hook CLI): `PreInvocation`/`PostInvocation` → `thinking`; `PreToolUse`/`PostToolUse` → `input` (only when the payload tool name matches `question`); `Stop` → `idle`.
- **hermes** (shell hooks via the same hook CLI): `pre_llm_call` → `thinking`; `post_llm_call` → `idle`; `pre_tool_call` → `input` (only when the tool name matches `question`; `post_tool_call` is intentionally NOT registered so a returned input tool does not re-set `input`); `pre_approval_request` → `input`; `post_approval_response` → `thinking`; `on_session_start` → `thinking`; `on_session_end` → `idle`; `subagent_start`/`subagent_stop` → `thinking`.
- **pi** (extension): `agent_start` → `thinking`; `agent_settled` → `idle`; `session_shutdown` → `idle`; `tool_call` (input tools) → `input`; `session_start` → notify.

After installing, run `node <skill-dir>/index.js status` and surface the JSON
`hint` to the user. A `hint` of "No `workled` server configured" means the
client's MCP is not set up — guide the user through the MCP endpoint
above.

> **Prevent / detect a placeholder URL.** `install` resolves the MCP URL once:
> `WORKLED_MCP_URL` → Bluetooth/mDNS discovery → placeholder
> `http://<device-name>.local:18791/mcp`. If no real URL is known and the
> target config has **no existing `workled` entry** (e.g. after an earlier
> uninstall), the placeholder is written. Fix it by editing the config URL to
> the real device name/IP, or re-run install with
> `WORKLED_MCP_URL=http://<device-name>.local:18791/mcp` set. A config that
> already holds a real URL is never downgraded to the placeholder.

### Marker line (grep-friendly)

```
<!-- workled -->
> when connected to a workled device via MCP, call `set_agent_state` on every agent state transition:
> - `set_agent_state("thinking")` while working
> - `set_agent_state("idle")` when the turn finishes; the user can continue with a new question
> - `set_agent_state("input")` when you need the user to confirm a choice, pick an option, or reply — INCLUDING plain-text choice lists and built-in client modals (hermes destructive-command panel, clarify, prompt_toolkit confirmations). Client hooks only fire on tool / LLM / approval events; they do NOT see these. Call it yourself before rendering the options.
> - `set_agent_state("error")` on errors
```

## Verify

After the device is reachable and the opencode plugin is loaded, trigger an LED
state change:

```
set_brightness(128)
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
(`WORKLED_MCP_URL` override wins), and checks reachability with a **stateless**
`tools/call get_agent_state` probe. Each URL is probed up to 3 times
with backoff; the successful attempt number is reported. Fields:

- `WORKLED_MCP_URL` — the override value, or `null`
- `workled` — `{ client, enabled, url, reachable, attempt, error? }`, or `null`
  when no `workled` server is configured; `attempt` is the probe attempt that
  succeeded (1-3)
- `clients` — one entry per discovered client config (`client`, `path`,
  `enabled`, `url`, `reachable`, `attempt`)
- `hint` — a concrete next step for the current state
- `ok` / `exitCode` — success flag and process exit code

- **Device not on the network yet** — connect to the device hotspot first and
  complete Wi-Fi provisioning (see "First use" above). After provisioning the
  device joins your home Wi-Fi automatically.
- **Device unreachable** — make sure the device is powered on and that your
  computer is on the same Wi-Fi network as the device.
- **mDNS name not resolving** — the device name must match the one configured
  for the device; it varies per device. `.local` (mDNS) resolution is
  **unreliable** on Windows/agents under load (per-request lookups can fail with
  `ENOTFOUND`, especially under concurrency). Prefer a **static IP / DHCP
  reservation** for the device and use the IP address in configs instead of the
  `.local` name.
- **Device dropped off the network** — the device can go offline silently
  (power loss / Wi-Fi sleep). Recheck `index.js status`; if the URL does not
  resolve at all, power-cycle the device and confirm it rejoined the LAN.
- **workled configured but disabled** — `workled.enabled` is `false`; enable it
  in your agent config or set `WORKLED_MCP_URL`.
- **Device reachable but the LED stays off** — check three things, in order:
  1. **Brightness may be 0** — run `set_brightness(128)`, or use the device's manual on/off switch.
  2. **MCP config not loaded yet** — after adding/editing the MCP server entry, **restart the agent or the session** so it reloads the config.
  3. **MCP connection not approved** — some agents require **manually allowing/trusting** the MCP connection before they will use it. Without approval the server is configured but never connected.
- **No MCP config found at all** — neither `WORKLED_MCP_URL` nor any config
  source declares the server. Add it under `mcp` in your agent config (see
  "MCP endpoint" above) or set the environment variable.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WORKLED_MCP_URL` | | Override the MCP server URL directly. |
