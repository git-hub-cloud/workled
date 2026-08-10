---
name: workled
description: "MUST call set_agent_state via MCP on each agent state transition (thinking, idle, input, error). Describes workled MCP peripheral tools: set_agent_state (LED indicator), and touch pad macro sequence configuration (single/double click, long press start/hold/up). Use when connected to a workled device via MCP, controlling the LED state indicator, or configuring HID macros."
---

# workled MCP Controller

## Mandatory State Protocol

Call `set_agent_state` via MCP on every state transition:

| State | When |
|-------|------|
| `thinking` | First tool call of every reply; user submits a message |
| `idle` | Turn finished; session torn down |
| `input` | **Any time the agent is waiting on the user** — calling an input tool (`question`/`ask`/`confirm`), sitting inside a client-side modal (hermes `_confirm_destructive_slash`, etc.), or after rendering a plain-text choice list / multi-option question and waiting for the user's pick |
| `error` | Runtime error occurred |

**Timing rule** (apply on every turn, in order):

1. Before rendering options / choices / opening any modal → `set_agent_state("input")`
2. User responds, next turn starting → `set_agent_state("thinking")` (or let `pre_llm_call` fire)
3. End of turn, done working, no more output pending → `set_agent_state("idle")`
4. Runtime error / failed tool call → `set_agent_state("error")`

## MCP Tool Reference

| Tool | Property | Description | Usage |
|---|---|---|---|
| set_agent_state | state_name: string | Set LED to reflect agent state (`thinking`/`idle`/`input`/`error`) | `set_agent_state("thinking")` |
| set_brightness | brightness: string | LED brightness 0-255 | `set_brightness("128")` |
| set_effect | effect_name: string, effect_json: string | effect_name ∈ `led`(manual effect)/`idle`/`thinking`/`input`/`error`; effect_json is a JSON string `{"type","hue","saturation","value","speed"}`. Map natural-language colors to HSV (see table below). | `set_effect("led", '{"type":"breathe","hue":180,"speed":50}')` |
| get_effect | effect_name: string | Get effect_name config as JSON | `get_effect("thinking")` |
| set_macro | macro_name: string, macro_string: string | Set the macro for a touch pad gesture; macro_name ∈ `single_click`/`double_click`/`long_press_start`/`long_press_hold`/`long_press_up`; empty macro_string resets | `set_macro("single_click", "ctrl+c")` |
| get_macro | macro_name: string | Returns the macro string, or empty string if unset | `get_macro("single_click")` |

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

If the device is not responding, run `node <skill-dir>/index.js status`
and follow the JSON `hint` it prints. Full install / deployment /
troubleshooting reference: [device_setup.md](references/device_setup.md)
