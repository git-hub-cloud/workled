---
name: workled
description: "MUST call set_agent_state via MCP on each agent state transition (thinking, idle, waiting, error). Use when connected to a workled device via MCP, controlling the agents state indicator, or configuring HID macros."
---

# workled MCP Controller

## Mandatory State Protocol

Call `set_agent_state` via MCP on every state transition. The MCP server name
varies by host — look for the server whose tools include *set_agent_state* in the block of the system prompt.

| State | When |
|-------|------|
| `thinking` | First tool call of every reply; user submits a message |
| `waiting` | **Call BEFORE asking the user for input** — before invoking an input tool (`AskUserQuestion`/`question`/`ask`/`confirm`), before opening a client-side modal, and before rendering a plain-text choice list / multi-option question. |
| `idle` | Turn finished; session torn down |
| `error` | Runtime error / failed tool call occurred |

**Per-turn procedure (execute every turn, in order):**

1. Turn starting / user message received → `set_agent_state("thinking")` — **first action, before any other tool call**.
2. Before rendering options / choices / opening any modal / asking a question → `set_agent_state("waiting")` — **BEFORE** the input tool call, not after the user answers. When the user answers/confirms → `set_agent_state("thinking")`.
3. End of turn, work done, no more output pending → `set_agent_state("idle")`.
4. Runtime error / failed tool call → `set_agent_state("error")`.

**Pre-Reply Gate — check BEFORE emitting your final visible message:**
- [ ] Did I call `set_agent_state` at least once this turn?
- [ ] Does the LED state match what I'm about to show (idle if done, waiting if asking, thinking if still working)?
- If either is **NO**, emit the correct `set_agent_state` call **first**, then the reply.

## MCP Tool Reference

| Tool | Property | Description | Usage |
|---|---|---|---|
| set_agent_state | state_name: string | Set LED to reflect agent state (`thinking`/`waiting`/`idle`/`error`) | `set_agent_state("thinking")` |
| get_agent_state | — | Returns current agent LED state (empty string if unset) | `get_agent_state()` |
| set_brightness | brightness: integer | LED brightness 0-255; 0 = off | `set_brightness(128)` |
| get_brightness | — | Returns current LED brightness 0-255; | `get_brightness()` |
| set_effect | effect_name: string, effect_json: string | effect_name ∈ `led`(manual effect)/`thinking`/`waiting`/`idle`/`error`/`touch`(touch effect); effect_json is a JSON string `{"type","hue","saturation","value","speed"}`. Light must be on first (set_brightness > 0). Map natural-language colors to HSV (see table below). | `set_effect("led", '{"type":"breathe","hue":180,"speed":50}')` |
| get_effect | effect_name: string | Get effect_name config as JSON | `get_effect("thinking")` |
| set_macro | macro_name: string, macro_json: string | Set the macro for a touch pad gesture; macro_name ∈ `single_click`/`double_click`/`long_press`; macro_json is a JSON array of segments (see Macro Format); empty macro_json resets | `set_macro("single_click", '[{"combo":"ctrl+c"}]')` |
| get_macro | macro_name: string | Returns the macro as a JSON array string, or empty string if unset (password values masked) | `get_macro("single_click")` |

### Mapping natural-language colors to `set_effect`

Use `type:"solid"` unless the user asks for an animation. Map a color name to HSV:

| Description | type | hue | saturation | value |
|---|---|---|---|---|
| pure white | solid | 0 | 0 | 255 |
| warm white | solid | 30 | 80 | 255 |
| red | solid | 0 | 255 | 255 |
| orange | solid | 30 | 255 | 255 |
| yellow | solid | 60 | 255 | 255 |
| green | solid | 120 | 255 | 255 |
| cyan/teal | solid | 180 | 255 | 255 |
| blue | solid | 240 | 255 | 255 |
| purple/violet | solid | 270 | 255 | 255 |
| pink | solid | 330 | 200 | 255 |
| dim/night mode | solid | 30 | 80 | 60 |
| rainbow (animated) | rainbow | - | - | - |

Rule of thumb: hue 0-359 picks the hue, saturation 0-255 (0 = white/pastel, 255 = vivid), value 0-255 brightness. Pastel/white tones use low saturation; vivid tones use 255.

## Macro Format

Full macro reference [macro_format.md](references/macro_format.md)

## Setup & Troubleshooting

Supported clients, install/uninstall commands, per-client event mapping, and full device
deployment steps: [device_setup.md](references/device_setup.md)

If the device is not responding, run `node <skill-dir>/index.js status`
and follow the JSON `hint` it prints.

## Contributing

- Repository: https://github.com/git-hub-cloud/workled
- Issues: https://github.com/git-hub-cloud/workled/issues
