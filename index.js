// workled core: shared MCP client + adapters for every supported client.
//
// Exports (named only - opencode auto-loads EVERY exported function as a
// plugin, so keep this file free of unrelated function exports; per-client
// entry files re-export the single adapter they need). All adapters share the
// same entry shape {id,name,description,register}:
//   opencodeEntry   - opencode adapter (register(ctx) returns hooks)
//   openclawEntry   - openclaw adapter (register(api) hooks api.on events)
//   piEntry         - pi adapter (register(pi) hooks pi.on events)
//
// CLI hook mode for agy/hermes (short-lived, stdin JSON):
//   node index.js hook [--event <name>]
// Reads the hook payload from stdin, maps the event to a state, sends it over
// MCP (awaiting completion so the process stays alive), and prints `{}`.
// The event->state mapping is unified across all hook-based clients.
//
// Works with the workled MCP server over streamable HTTP. Discovery order:
//   WORKLED_MCP_URL env -> opencode config (mcp.*.url) global + project.

import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { stripJsonc, hermesHome, sleep } from "./utils.js";

const HOME = homedir();
const execFileAsync = promisify(execFile);

// SKILL_VERSION: single-sourced from _meta.json (the skill registry metadata);
// package.json only declares the module type and is not read here.
let SKILL_VERSION = "";
try {
  const metaPath = join(import.meta.dirname, "_meta.json");
  if (existsSync(metaPath)) {
    SKILL_VERSION = JSON.parse(stripJsonc(readFileSync(metaPath, "utf8"))).version || "";
  }
} catch {
  // fallback to default
}

// Single source of truth for the MCP config files each client keeps its MCP
// servers in. Used by loadMcpServers() here and by the uninstall cleanup in
// skill-install.mjs, so the client list and config paths cannot drift.
//
//   client  - "<name>.<scope>" (scope: global | project)
//   key     - top-level key that holds the server map (mcp / mcpServers); the
//             hermes YAML reader resolves "mcp_servers" internally
//   format  - json (JSONC tolerated via stripJsonc) | yaml
//   path    - resolved lazily so `projectDir` (cwd, updated on register) and
//             $HERMES_HOME are always read at call time, never frozen at load.
export const MCP_SOURCES = [
  // opencode (global + project)
  { client: "opencode.global", key: "mcp", format: "json", path: () => join(HOME, ".config", "opencode", "opencode.json") },
  { client: "opencode.global", key: "mcp", format: "json", path: () => join(HOME, ".config", "opencode", "opencode.jsonc") },
  { client: "opencode.project", key: "mcp", format: "json", path: () => join(projectDir, "opencode.json") },
  { client: "opencode.project", key: "mcp", format: "json", path: () => join(projectDir, "opencode.jsonc") },
  // kilo (opencode fork)
  { client: "kilo.global", key: "mcp", format: "json", path: () => join(HOME, ".config", "kilo", "kilo.jsonc") },
  // agy / gemini (two possible global locations + project)
  { client: "agy.global", key: "mcpServers", format: "json", path: () => join(HOME, ".gemini", "config", "mcp.json") },
  { client: "agy.global", key: "mcpServers", format: "json", path: () => join(HOME, ".gemini", "antigravity-cli", "mcp.json") },
  { client: "agy.project", key: "mcpServers", format: "json", path: () => join(projectDir, ".gemini", "mcp.json") },
  // openclaw
  { client: "openclaw.global", key: "mcp", format: "json", path: () => join(HOME, ".openclaw", "openclaw.json") },
  // pi
  { client: "pi.global", key: "mcp", format: "json", path: () => join(HOME, ".pi", "mcp.json") },
  // workbuddy (JSON, mcpServers key, ~/.workbuddy/mcp.json)
  { client: "workbuddy.global", key: "mcpServers", format: "json", path: () => join(HOME, ".workbuddy", "mcp.json") },
  // hermes (YAML)
  { client: "hermes.global", key: "mcp_servers", format: "yaml", path: () => join(hermesHome(), "config.yaml") },
];

// Every client the skill installs to. `status` accepts an optional
// `--client <name>` filter that must be one of these. Derived from MCP_SOURCES
// so it stays in sync: to add a client, extend MCP_SOURCES above and add the
// matching install/uninstall branch in skill-install.mjs + SKILL.md.
export const CLIENTS = [...new Set(MCP_SOURCES.map((s) => s.client.split(".")[0]))];

// Per-client install targets — the single source of truth for where each
// client's workled integration lives. skill-install.mjs derives both the
// `--help` text and the plugin-file install logic from it, so a client's
// paths are maintained exactly once. Keys match CLIENTS (itself derived from
// MCP_SOURCES); `default` is the fallback used by --help.
//
//   plugin clients (opencode/kilo/pi): carry `dest` + `agents` + `label`;
//     install = write generated entry file to dest + AGENTS.md reminder.
//   other clients: carry only free-form `help` text (their install logic is
//     bespoke and lives in skill-install.mjs).
export const CLIENT_TARGETS = {
  opencode: {
    label: "plugin",
    dest: () => join(HOME, ".config", "opencode", "plugins", "workled.js"),
    agents: () => join(HOME, ".config", "opencode", "AGENTS.md"),
  },
  kilo: {
    label: "plugin",
    dest: () => join(HOME, ".config", "kilo", "plugin", "workled.js"),
    agents: () => join(HOME, ".config", "kilo", "AGENTS.md"),
  },
  openclaw: {
    help: "entry  -> ~/.openclaw/plugins/workled/ + openclaw.plugin.json + openclaw.json (load.paths + entries) + reminder in AGENTS.md",
  },
  agy: {
    help: "hooks  -> ~/.gemini/config/hooks.json            + reminder in AGENTS.md",
  },
  hermes: {
    help: "hooks  -> <hermes-home>/config.yaml (~/.hermes on unix, %LOCALAPPDATA%\\hermes on Windows) + reminder in AGENTS.md",
  },
  pi: {
    label: "extension",
    dest: () => join(HOME, ".pi", "agent", "extensions", "workled.ts"),
    agents: () => join(HOME, ".pi", "AGENTS.md"),
  },
  workbuddy: {
    help: "mcp    -> ~/.workbuddy/mcp.json (mcpServers.workled)   + SKILL.md (protocol already loaded)",
  },
  default: {
    help: "installed (targets: see SKILL.md)",
  },
};

const DEFAULT_RPC_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const WORKLED_URL_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Monotonic counter for JSON-RPC request ids. JSON-RPC 2.0 requires a valid
// id on every request (the server echoes it back and rejects a missing or
// null id with -32600), and the firmware rejects duplicate ids within a
// session, so keep ids unique per process even though requests are currently
// single-flight and stateless.
let nextRpcId = 1;

function getInputTools() {
  return (process.env.WORKLED_INPUT_TOOLS || "question")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function sleepWithJitter(baseMs, attempt) {
  // Exponential backoff with jitter: base * 2^attempt * (0.5 ~ 1.5)
  const expDelay = baseMs * Math.pow(2, attempt);
  const jitter = expDelay * (0.5 + Math.random());
  return sleep(Math.floor(jitter));
}

// Run a child command, retrying once on failure (transient errors, sandbox
// flakiness, or a briefly-blocked powershell). Returns the execFileAsync result
// and only throws after all attempts are exhausted.
async function execWithRetry(cmd, args, opts, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await execFileAsync(cmd, args, opts);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await sleep(300);
      }
    }
  }
  throw lastErr;
}

let workledUrl = null;
let workledUrlExpiry = 0;
let hookClientPrefix = null;
let projectDir = process.cwd();
const seenUserMessages = new Set();
let seenMessagesCleanedAt = 0;
const SEEN_MESSAGES_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Config candidates cache (parsed server list with name==='workled', enabled, url)
let cachedCandidates = null;
let candidatesExpiry = 0;
const CANDIDATES_TTL_MS = 60 * 1000; // 1 minute

// Minimal YAML reader for the `mcp_servers:` block in hermes config.yaml.
// Top-level `mcp_servers:` then `  <name>:` then `    key: value` scalars;
// nested lists/objects beyond that are left out (not needed for MCP servers).
function mcpServersFromYaml(text) {
  const lines = text.split("\n");
  const root = {};
  let section = null; // "mcp_servers" when inside the block
  let serverName = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, ""); // tolerate CRLF files
    const m = line.match(/^(\s*)(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const content = m[2].trim();
    if (content === "" || content.startsWith("#")) continue;
    if (indent === 0) {
      const topKey = content.replace(/:.*$/, "").trim();
      section = topKey === "mcp_servers" ? topKey : null;
      serverName = null;
      continue;
    }
    if (!section) continue;
    if (indent === 2) {
      const name = content.replace(/:\s*$/, "").trim();
      const inline = content.match(/^([^:]+):\s*(.+)$/);
      if (inline) {
        if (!root[name]) root[name] = {};
        root[name][inline[1].trim()] = stripValue(inline[2].trim());
      } else if (content.endsWith(":")) {
        serverName = name;
        if (!root[serverName]) root[serverName] = {};
      }
      continue;
    }
    if (indent >= 4 && serverName) {
      const kv = content.match(/^([^:]+):\s*(.+)$/);
      if (kv && !content.startsWith("-")) {
        root[serverName][kv[1].trim()] = stripValue(kv[2].trim());
      }
    }
  }
  return root;
}

function stripValue(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// Scan every MCP_SOURCES entry and return the MCP servers it declares, each
// tagged with its source (client.scope + path).
function loadMcpServers() {
  const servers = [];
  for (const s of MCP_SOURCES) {
    const srcPath = s.path();
    if (!existsSync(srcPath)) continue;
    try {
      const text = readFileSync(srcPath, "utf8");
      const parsed = s.format === "yaml" ? mcpServersFromYaml(text) : JSON.parse(stripJsonc(text));
      const m = s.format === "yaml" || !parsed || typeof parsed !== "object" ? parsed : parsed[s.key];
      if (m && typeof m === "object") {
        for (const [name, server] of Object.entries(m)) {
          if (server && typeof server === "object") {
            servers.push({ name, client: s.client, path: srcPath, server });
          }
        }
      }
    } catch {
      // unreadable config file: skip
    }
  }
  return servers;
}

function getWorkledCandidates(clientPrefix) {
  const now = Date.now();
  if (cachedCandidates && now < candidatesExpiry) {
    if (!clientPrefix) return cachedCandidates;
    return cachedCandidates.filter((c) => c.client.startsWith(clientPrefix));
  }
  const servers = loadMcpServers();
  const candidates = [];
  for (const s of servers) {
    if (s.name !== "workled") continue;
    if (!s.server || typeof s.server !== "object") continue;
    if (s.server.enabled === false) continue;
    if (s.server.url) candidates.push({ url: s.server.url, client: s.client });
  }
  cachedCandidates = candidates;
  candidatesExpiry = now + CANDIDATES_TTL_MS;
  if (!clientPrefix) return candidates;
  return candidates.filter((c) => c.client.startsWith(clientPrefix));
}

// Best-effort host-side Bluetooth diagnostic. Returns { available, powered,
// devicePaired, deviceName, error }. On unsupported platforms or missing
// adapters the fields degrade gracefully so the caller never throws.
//
// `available` is tri-state:
//   true  - a Bluetooth adapter was found
//   false - the probe ran and definitively found no adapter
//   null  - the probe could not be executed (powershell missing/blocked, a
//           sandbox restriction, or a command failure after retries). We report
//           "unknown" instead of falsely claiming "no adapter", so a blocked
//           probe never masquerades as a missing adapter.
//
// `devicePaired` / `deviceName` are workled-specific: they report the workled
// device (name matches HomeAnt|workled) rather than any HID/keyboard device,
// so the macro-readiness hint is accurate.
export async function probeBluetooth(timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  const result = {
    available: null,
    powered: false,
    devicePaired: false,
    deviceName: null,
    error: null,
  };

  try {
    if (process.platform === "win32") {
      try {
        const { stdout: adapterOut } = await execWithRetry(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status",
          ],
          { timeout: timeoutMs }
        );
        const statuses = adapterOut.trim().split(/\r?\n/).filter(Boolean);
        result.available = statuses.length > 0;
        result.powered = statuses.some((s) => s.toLowerCase() === "ok");

        try {
          // Workled-specific: match the device name (HomeAnt-* or workled),
          // not any generic HID/keyboard/bluetooth device.
          const { stdout: hidOut } = await execWithRetry(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              "Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'HomeAnt|workled' } | Select-Object -First 1 -ExpandProperty FriendlyName",
            ],
            { timeout: timeoutMs }
          );
          if (hidOut.trim()) {
            result.devicePaired = true;
            result.deviceName = hidOut.trim();
          }
        } catch {
          // workled device not found among PnP devices (not paired yet)
        }
      } catch {
        result.available = null;
        result.error =
          "Bluetooth probe could not run (powershell unavailable or blocked)";
      }
    } else if (process.platform === "darwin") {
      try {
        const { stdout } = await execFileAsync("blueutil", ["--power"], { timeout: timeoutMs });
        result.powered = stdout.trim() === "1";
        result.available = true;

        try {
          const { stdout: pairedOut } = await execFileAsync("blueutil", ["--paired"], {
            timeout: timeoutMs,
          });
          const lines = pairedOut.trim().split(/\r?\n/).filter(Boolean);
          const hidLine = lines.find((l) => /homeant|workled|keyboard|hid/i.test(l));
          if (hidLine) {
            result.devicePaired = true;
            const m = hidLine.match(/address:\s*([^\s,]+)/i);
            result.deviceName = m ? m[1] : hidLine.split(",")[0]?.trim() || null;
          }
        } catch {
          // no paired devices
        }
      } catch {
        try {
          const { stdout } = await execFileAsync(
            "system_profiler",
            ["SPBluetoothDataType", "-json"],
            { timeout: timeoutMs }
          );
          const data = JSON.parse(stdout);
          result.available = true;
          result.powered = true;

          const devices =
            data.SPBluetoothDataType?.[0]?.device_connected ||
            data.SPBluetoothDataType?.[0]?.device_paired ||
            [];
          const hidDevice = devices.find((d) =>
            /homeant|workled|keyboard|hid/i.test(d.device_name || "") ||
            /homeant|workled|keyboard|hid/i.test(d.device_type || "")
          );
          if (hidDevice) {
            result.devicePaired = true;
            result.deviceName = hidDevice.device_name || null;
          }
        } catch {
          result.available = null;
          result.error =
            "Bluetooth not available (install blueutil or enable system_profiler)";
        }
      }
    } else if (process.platform === "linux") {
      try {
        const { stdout } = await execFileAsync("bluetoothctl", ["show"], { timeout: timeoutMs });
        result.available = stdout.includes("Controller");
        result.powered = stdout.includes("Powered: yes");

        try {
          const { stdout: devOut } = await execFileAsync("bluetoothctl", ["devices"], {
            timeout: timeoutMs,
          });
          const lines = devOut.trim().split(/\r?\n/).filter(Boolean);
          const wlLine = lines.find((l) => /homeant|workled/i.test(l));
          if (wlLine) {
            result.devicePaired = true;
            result.deviceName = wlLine.split(/\s+/).slice(2).join(" ") || null;
          } else if (lines.length > 0) {
            result.devicePaired = true;
            result.deviceName = lines[0].split(/\s+/).slice(2).join(" ") || null;
          }
        } catch {
          // no paired devices
        }
      } catch {
        result.available = null;
        result.error = "bluetoothctl not available";
      }
    } else {
      result.error = `Unsupported platform: ${process.platform}`;
    }
  } catch {
    result.available = null;
    result.error = "Bluetooth probe failed";
  }

  return result;
}

// Parse a JSON-RPC response body. Accepts a plain JSON object/array (stateless
// JSON transport) or an SSE stream (`data:` lines). On failure it throws with
// the offending snippet so rpc()/probeReachable surface a diagnosable error
// instead of a raw JSON.parse exception.
function extractJson(text) {
  const trimmed = (text || "").trim();
  // Direct JSON object/array
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`Invalid JSON: ${trimmed.substring(0, 100)}`);
    }
  }
  // SSE data lines
  const data = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  if (!data) throw new Error("No JSON data found in response");
  try {
    return JSON.parse(data);
  } catch {
    throw new Error(`Invalid JSON: ${data.substring(0, 100)}`);
  }
}

// POST a single JSON-RPC request without any session header.
async function postJson(url, method, params, controller, extraHeaders = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extraHeaders,
    },
    signal: controller.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

// Send a JSON-RPC request, stateless-only. The device server runs with
// stateless support (MCP 2026-07-28+ / bare requests without a version header
// are served without a session), so there is no session fallback: a JSON-RPC
// error in the response is surfaced as an exception for the caller's retry
// logic. The error message carries the firmware's `data.reason` (e.g.
// "initialize must be first interaction") so status output is self-explanatory.
async function rpc(url, method, params, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { status, text } = await postJson(url, method, params, controller);
    const out = extractJson(text);
    if (out && out.error) {
      const detail = out.error.data && (out.error.data.reason || out.error.data.method);
      throw new Error(
        `workled rpc: JSON-RPC error ${out.error.code}: ${out.error.message}${detail ? ` (${detail})` : ""} (HTTP ${status})`
      );
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverWorkledUrl(clientPrefix) {
  if (process.env.WORKLED_MCP_URL) return process.env.WORKLED_MCP_URL;
  if (workledUrl && Date.now() < workledUrlExpiry) return workledUrl;
  const candidates = getWorkledCandidates(clientPrefix);
  if (candidates.length === 0) return null;

  // Single-candidate mode: return the first configured URL directly, without
  // any probe (the server is stateless).
  const url = candidates[0].url;
  workledUrl = url;
  workledUrlExpiry = Date.now() + WORKLED_URL_TTL_MS;
  return url;
}

let pendingState = null;
let senderRunning = false;
// Track flush promises for CLI hook mode
const flushPromises = [];
// The last state actually delivered via MCP (set only on a successful send).
// Used to dedup consecutive identical states WITHOUT poisoning future recovery:
// a failed send must NOT be recorded here, or an identical later request would
// be suppressed and the LED would stay stuck on the wrong state.
let lastSentState = null;

// Settle every pending flush promise (used by sendLoop when a state's send
// completes or the sender loop exits).
function resolveFlushPromises(result) {
  while (flushPromises.length > 0) flushPromises.shift().resolve(result);
}
function rejectFlushPromises(err) {
  while (flushPromises.length > 0) flushPromises.shift().reject(err);
}

async function sendLoop() {
  try {
    while (pendingState !== null) {
      const state = pendingState;
      pendingState = null;
      const maxAttempts = DEFAULT_MAX_ATTEMPTS;
      const baseDelay = DEFAULT_RETRY_DELAY_MS;
      let lastErr = null;
      let sent = false;
      let superseded = false;

      // Fast-fail when no MCP URL is configured/discoverable: no point retrying.
      const url = await discoverWorkledUrl(hookClientPrefix);
      if (!url) {
        lastErr = new Error("MCP URL not configured or not discovered");
        const result = { state, sent, error: lastErr, superseded: false };
        resolveFlushPromises(result);
        console.warn(`[workled] setAgentState(${state}) skipped: no MCP URL available`);
        continue;
      }

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (pendingState !== null) {
          // a newer state superseded this one; drop it and send the latest next
          superseded = true;
          lastErr = null;
          break;
        }
        try {
          await rpc(url, "tools/call", { name: "set_agent_state", arguments: { state_name: state } });
          lastErr = null;
          sent = true;
          lastSentState = state;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts - 1 && pendingState === null) {
            await sleepWithJitter(baseDelay, attempt);
          }
        }
      }
      // Resolve any waiting flush promises for this state
      const result = { state, sent, error: lastErr, superseded };
      resolveFlushPromises(result);
      if (lastErr) {
        // give up on this state; no resend later
        console.warn(`[workled] setAgentState(${state}) failed after ${maxAttempts} attempts: ${lastErr.message || lastErr}`);
      }
    }
  } finally {
    senderRunning = false;
    // Reject any remaining flush promises if sender exits unexpectedly
    rejectFlushPromises(new Error("Sender loop exited unexpectedly"));
  }
}

function setAgentState(state) {
  // Dedup consecutive identical states already delivered and drained. Keyed on
  // lastSentState (not last requested) so a previously-failed state is never
  // suppressed and will be re-queued on the next request.
  if (state === lastSentState && pendingState === null) {
    return;
  }
  pendingState = state;
  if (!senderRunning) {
    senderRunning = true;
    sendLoop().catch((err) => {
      console.warn(`[workled] sender loop error: ${err && err.message}`);
    });
  }
}

// CLI hook mode: wait until the queue drains so the short-lived process does
// not exit before the MCP call completes. Timeout after 15s to avoid hanging
// the process if the sender loop is stuck.
// Returns a promise that resolves with { state, sent, error } for the last state.
const FLUSH_TIMEOUT_MS = 15000; // must exceed WORKLED_HOOK_TIMEOUT_MS so the host's hook budget never truncates an in-flight send
async function flushState() {
  // If nothing pending and not running, return immediately
  if (pendingState === null && !senderRunning) {
    return { state: null, sent: true, error: null, superseded: false };
  }

  // Resolves when the current state is sent; the timeout timer is cleared as
  // soon as flush settles so short-lived hook processes do not linger.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`flushState timeout after ${FLUSH_TIMEOUT_MS}ms`)),
      FLUSH_TIMEOUT_MS
    );
    flushPromises.push({
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

function getUserMessage(event) {
  if (event.type !== "message.updated") return null;
  const props = event.properties || {};
  const msg = props.info || {};
  if (msg.role !== "user") return null;
  return msg;
}

// Register a seen user-message id and opportunistically clear the dedup set
// when it grows too large or goes stale. Shared by the opencode and openclaw
// adapters so per-turn "thinking" is only triggered once per message.
function markSeenMessage(id) {
  seenUserMessages.add(id);
  if (seenUserMessages.size > 200 || Date.now() - seenMessagesCleanedAt > SEEN_MESSAGES_CLEANUP_INTERVAL_MS) {
    seenUserMessages.clear();
    seenMessagesCleanedAt = Date.now();
  }
}

// ---- opencode adapter --------------------------------------------------------
//
// opencode plugins are exported as FUNCTIONS (async (ctx) => ({ hooks })), so
// the core keeps the same entry shape as openclawEntry and the generated entry
// file adapts it:
//   import { opencodeEntry as core } from ".../index.js";
//   export const workled = async (ctx) => await core.register(ctx);
//
// kilo (Anomaly) is an opencode fork: its Event/Hooks types are identical, so
// this adapter is reused verbatim. kilo only differs in the module shape:
//   import { opencodeEntry as core } from ".../index.js";
//   export default { id: "workled", server: async (ctx) => await core.register(ctx) }

export const opencodeEntry = {
  id: "workled",
  name: "workled",
  description:
    "Maps opencode agent lifecycle events (thinking/idle/input/error) to the workled MCP set_agent_state tool driving the LED strip.",
  async register(ctx) {
    const directory = ctx && ctx.directory;
    projectDir = directory || projectDir;
    try {
      await discoverWorkledUrl("opencode");
    } catch {
      // discovery retried lazily on first user message
    }
    return {
      event: async ({ event }) => {
        try {
          if (event.type === "session.idle") {
            setAgentState("idle");
            return;
          }
          if (event.type === "session.error") {
            setAgentState("error");
            return;
          }
          // session.status: busy/retry means work is in progress (covers new
          // user input, question reply, and permission approval resuming the
          // turn); idle means finished.
          if (event.type === "session.status") {
            const status = event.properties && event.properties.status;
            if (status && (status.type === "busy" || status.type === "retry")) {
              setAgentState("thinking");
            } else if (status && status.type === "idle") {
              setAgentState("idle");
            }
            return;
          }
          // permission.asked -> input (tool approval popup shown);
          // permission.replied -> thinking (resolved).
          if (event.type === "permission.asked" || event.type === "question.asked") {
            setAgentState("input");
            return;
          }
          if (event.type === "permission.replied" || event.type === "question.replied" || event.type === "question.rejected") {
            setAgentState("thinking");
            return;
          }
          const msg = getUserMessage(event);
          if (!msg) return;
          const id = msg.id || JSON.stringify(msg);
          if (seenUserMessages.has(id)) return;
          markSeenMessage(id);
          setAgentState("thinking");
        } catch (err) {
          // Never block the user workflow; device unreachable is skipped gracefully.
          console.warn(`[workled] event handler error: ${err && err.message}`);
        }
      },
      "tool.execute.before": async (input) => {
        const wanted = getInputTools().map((t) => t.toLowerCase());
        try {
          const toolName = input && input.tool ? String(input.tool).toLowerCase() : "";
          if (toolName && wanted.includes(toolName)) {
            setAgentState("input");
          }
        } catch (err) {
          // Never block the tool pipeline; device unreachable is skipped gracefully.
          console.warn(`[workled] tool hook error: ${err && err.message}`);
        }
      },
    };
  },
};

// ---- openclaw adapter (best-effort) -----------------------------------------
//
// OpenClaw plugins are loaded by the Gateway via `plugins.load.paths`; the
// entry is usually `export default definePluginEntry(...)`. The SDK wrapper
// lives in openclaw's node_modules, which the unified file must NOT import at
// top level (opencode auto-loads every function export and would fail on an
// unresolvable import). Installers therefore wrap this shape:
//   import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
//   import { openclawEntry } from ".../index.js";
//   export default definePluginEntry(openclawEntry);
// Event names/fields follow the OpenClaw plugin-hook docs and are best-effort.

export const openclawEntry = {
  id: "workled",
  name: "workled controller",
  description:
    "Maps OpenClaw agent lifecycle events (thinking/idle/input/error) to the workled MCP set_agent_state tool driving the LED strip.",
  register(api) {
    // Inbound user message starts a turn -> thinking.
    api.on("before_agent_run", async (event, ctx) => {
      try {
        const id = event.messageId || JSON.stringify(event);
        if (seenUserMessages.has(id)) return;
        markSeenMessage(id);
        setAgentState("thinking");
      } catch (err) {
        console.warn(`[workled] before_agent_run hook error: ${err && err.message}`);
      }
    });

    // Tool call that needs a user decision -> input
    api.on("before_tool_call", async (event) => {
      try {
        const inputTools = getInputTools();
        const name =
          (event && (event.toolName || event.tool || event.name)) || "";
        if (inputTools.includes(name)) {
          setAgentState("input");
        }
      } catch (err) {
        console.warn(`[workled] before_tool_call hook error: ${err && err.message}`);
      }
    });

    // Turn finished -> idle (or error when the run reports failure).
    // Note: if event is missing/falsy, default to idle (best-effort).
    // Only explicitly flag "error" when success === false or outcome === "error".
    api.on("agent_end", async (event) => {
      try {
        let failed = false;
        if (event) {
          if (event.success === false) failed = true;
          else if (event.outcome === "error") failed = true;
          else if (event.error) failed = true;
        }
        setAgentState(failed ? "error" : "idle");
      } catch (err) {
        console.warn(`[workled] agent_end hook error: ${err && err.message}`);
      }
    });

    // Session torn down -> idle fallback so the LED is not stuck in a busy state.
    api.on("session_end", async (event) => {
      try {
        setAgentState("idle");
      } catch (err) {
        console.warn(`[workled] session_end hook error: ${err && err.message}`);
      }
    });
  },
};

// ---- pi adapter ---------------------------------------------------------------
//
// pi loads `~/.pi/agent/extensions/*.ts` (or *.js) and takes the module's
// DEFAULT export as `(pi: ExtensionAPI) => void`. Like the other adapters the
// core exposes an entry object, and the generated extension file adapts it:
//   import { piEntry } from ".../index.js";
//   export default (pi) => piEntry.register(pi);

export const piEntry = {
  id: "workled",
  name: "workled controller",
  description:
    "Maps pi agent lifecycle events (thinking/idle/input/error) to the workled MCP set_agent_state tool driving the LED strip.",
  register(pi) {
    console.log("[workled] extension loaded");

    pi.on("agent_start", async () => {
      setAgentState("thinking");
    });

    pi.on("agent_end", async (event) => {
      // agent_end fires for each low-level run; use agent_settled for final idle.
      // Note: pi's agent_end may fire multiple times per turn; we ignore it
      // here to avoid premature idle. agent_settled is the reliable final state.
    });

    pi.on("agent_settled", async () => {
      setAgentState("idle");
    });

    pi.on("session_shutdown", async () => {
      setAgentState("idle");
    });

    pi.on("tool_call", async (event) => {
      // Best-effort input detection: pi has no built-in question tool, but
      // extensions may register interactive tools. Match by tool name.
      const inputTools = getInputTools();
      const name =
        (event && (event.toolName || event.tool || event.name)) || "";
      if (inputTools.includes(name)) {
        setAgentState("input");
      }
    });

    pi.on("session_start", async (_event, ctx) => {
      try {
        const url = await discoverWorkledUrl("pi");
        if (url && ctx && ctx.ui) {
          ctx.ui.notify(`workled connected: ${url}`, "info");
        }
      } catch {
        // device unreachable: skip gracefully
      }
    });
  },
};

// ---- default export for OpenClaw ------------------------------------------
// OpenClaw expects a module with `register` or `activate` as the default export.
// We wrap the openclawEntry adapter so the gateway can load the plugin directly.
export default { register: openclawEntry.register, activate: openclawEntry.register };

// ---- CLI hook mode (agy / hermes) -------------------------------------------

// Event name -> state, unified across every hook-based client (agy, hermes).
// Event names are unique per client so no conflicts arise; the same mapping
// serves all of them. Tool events map to "input" only when the payload
// references an input tool (checked by extractToolName below).
const HOOK_MAP = {
  // WorkBuddy (Claude Code-compatible hooks in ~/.workbuddy/settings.json)
  UserPromptSubmit: "thinking",
  // agy / gemini (camelCase)
  Stop: "idle",
  PreInvocation: "thinking",
  PostInvocation: "thinking",
  PreToolUse: "tool",
  PostToolUse: "tool",
  // hermes shell-hook events (snake_case)
  pre_llm_call: "thinking",
  post_llm_call: "idle",
  pre_tool_call: "tool",
  pre_approval_request: "input",
  post_approval_response: "thinking",
  on_session_start: "thinking",
  on_session_end: "idle",
  subagent_start: "thinking",
  subagent_stop: "thinking",
};

function extractToolName(payload) {
  const p = payload || {};
  return (
    p.tool_name ||
    p.toolName ||
    p.tool ||
    (p.input && (p.input.tool || p.input.toolName)) ||
    (p.toolCall && (p.toolCall.name || p.toolCall.tool)) ||
    ""
  );
}

function toolIsInput(toolName) {
  const lowered = (toolName || "").toLowerCase();
  if (!lowered) return false;
  return getInputTools().some((t) => {
    const needle = t.toLowerCase();
    // Match on exact name OR substring: a default token like "question" should
    // also catch "AskUserQuestion", while explicit exact names still work.
    return needle === lowered || lowered.includes(needle);
  });
}

function resolveHookState(event, payload) {
  const target = HOOK_MAP[event];
  if (!target) return null;
  if (target === "tool") {
    const toolName = extractToolName(payload);
    if (!toolIsInput(toolName)) return null;
    return "input";
  }
  return target;
}

// Single shared hook timeout budget (milliseconds), used directly by the internal
// flush cap below. skill-install.mjs converts it to seconds for the host's hook
// `timeout` in settings.json. This is the one tunable for the whole hook budget.
export const WORKLED_HOOK_TIMEOUT_MS = 10000;

async function runHookMode() {
  try {
    const argv = process.argv.slice(2);
    const eventIdx = argv.indexOf("--event");
    const eventArg = eventIdx >= 0 ? argv[eventIdx + 1] : null;
    const clientIdx = argv.indexOf("--client");
    const clientArg = clientIdx >= 0 ? argv[clientIdx + 1] : null;
    if (clientArg) hookClientPrefix = clientArg;

    // Read the hook JSON payload from stdin (agy may pass the event name via
    // --event instead). Never block on stdin: if the host never closes it
    // (e.g. a hook event with no payload), proceed after a short grace period
    // so this short-lived process always exits and never stalls the host's
    // tool call / turn.
    const chunks = [];
    const stdinDone = (async () => {
      for await (const chunk of process.stdin) chunks.push(chunk);
    })();
    await Promise.race([stdinDone, sleep(500)]);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(stripJsonc(raw));
      } catch {
        payload = {};
      }
    }

    const event = eventArg || payload.hook_event_name || payload.event || null;
    if (!event) {
      return;
    }
    const state = resolveHookState(event, payload);
    if (state) {
      setAgentState(state);
      try {
        const result = await Promise.race([
          flushState(),
          sleep(WORKLED_HOOK_TIMEOUT_MS).then(() => ({ state, sent: false, superseded: false, timeout: true })),
        ]);
        if (!result.sent && !result.superseded && !result.timeout) {
          console.warn(`[workled] hook: state ${result.state} not sent: ${result.error && result.error.message}`);
        }
      } catch (err) {
        console.warn(`[workled] hook flush error: ${err && err.message}`);
      }
    }
  } catch (err) {
    // Never propagate: the hook process must always exit cleanly (stdout {}
    // + status 0) so the host's tool call is never denied or delayed.
    console.warn(`[workled] hook error: ${err && err.message}`);
  } finally {
    // Always print an empty JSON object so the hook never blocks or denies.
    // Do NOT hard-exit while a state send may still be in flight: process.exit
    // would abort the in-flight HTTP request before the device receives it
    // (the first call after a fresh process is a single stateless
    // tools/call, which still exceeds the flush cap because of node startup
    // latency). Let the event loop drain — the
    // pending socket keeps the process alive until the send settles — then exit.
    process.stdout.write("{}\n");
    setTimeout(() => process.exit(0), 50).unref();
  }
}

// ---- status mode (diagnostics) ---------------------------------------------

// Reachability probe: a bare stateless tools/call to get_agent_state. No
// initialize handshake or session needed (the server serves stateless
// requests), and it also verifies the endpoint is really a workled server:
// only workled knows the get_agent_state tool. Reuses rpc() so error handling
// stays in one place; any throw (HTTP/JSON-RPC/network) means unreachable.
// Retries DEFAULT_MAX_ATTEMPTS times with backoff and reports which attempt
// succeeded so `status` can distinguish a flaky-but-working link from a dead
// one.
async function probeReachable(url, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  let lastErr = null;
  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
    try {
      await rpc(url, "tools/call", { name: "get_agent_state", arguments: {} }, timeoutMs);
      return { reachable: true, error: null, attempt };
    } catch (err) {
      lastErr = err;
      if (attempt < DEFAULT_MAX_ATTEMPTS) {
        await sleepWithJitter(DEFAULT_RETRY_DELAY_MS, attempt - 1);
      }
    }
  }
  return {
    reachable: false,
    error: (lastErr && lastErr.message) || String(lastErr),
    attempt: DEFAULT_MAX_ATTEMPTS,
  };
}

// status: scan every client config source, keep only sources declaring a
// `workled` server, and probe each unique URL with a bare stateless
// tools/call.
// `clients` is omitted entirely when no workled server is configured.
async function runStatusMode() {
  const out = { hint: "", ok: false, exitCode: 1 };

  // Optional per-client filter: `--client <name>` restricts the scan to
  // matching sources; omitted means all clients. Env override is always shown.
  const clientIdx = process.argv.indexOf("--client");
  const clientPrefix = clientIdx >= 0 ? process.argv[clientIdx + 1] : null;
  if (clientPrefix && !CLIENTS.some((c) => c.startsWith(clientPrefix))) {
    console.error(`Unknown client: ${clientPrefix}\nSupported clients: ${CLIENTS.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const entries = [];
  const envUrl = process.env.WORKLED_MCP_URL;
  if (envUrl) {
    // WORKLED_MCP_URL override wins and is reported first.
    entries.push({ client: "env", path: "WORKLED_MCP_URL", enabled: true, url: envUrl });
  }
  for (const s of loadMcpServers()) {
    if (s.name !== "workled") continue;
    if (clientPrefix && !s.client.startsWith(clientPrefix)) continue;
    entries.push({
      client: s.client,
      path: s.path,
      enabled: s.server.enabled !== false,
      url: s.server.url || null,
    });
  }

  if (entries.length === 0) {
    out.hint = clientPrefix
      ? `No \`workled\` server configured for client "${clientPrefix}". Add it under \`mcp\` in that client's config or set WORKLED_MCP_URL.`
      : "No `workled` server configured. Add it under `mcp` in your agent config or set WORKLED_MCP_URL.";
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.exitCode;
    return;
  }

  const bluetooth = await probeBluetooth().catch(() => ({
    available: false,
    powered: false,
    devicePaired: false,
    deviceName: null,
    error: "Bluetooth probe failed",
  }));
  out.bluetooth = bluetooth;

  // Probe each unique URL once.
  const results = new Map();
  for (const e of entries) {
    if (!e.url || !e.enabled) continue;
    if (!results.has(e.url)) {
      results.set(e.url, await probeReachable(e.url));
    }
  }

  out.clients = entries.map((e) => {
    const probe = e.url && e.enabled ? results.get(e.url) : null;
    const entry = {
      client: e.client,
      path: e.path,
      enabled: e.enabled,
      url: e.url,
      reachable: !!(probe && probe.reachable),
    };
    if (probe && probe.error) entry.error = probe.error;
    // Which attempt (1-based) succeeded, or how many were tried when failing.
    if (probe && probe.attempt) entry.attempt = probe.attempt;
    return entry;
  });

  if (out.clients.some((c) => c.reachable)) {
    out.ok = true;
    out.exitCode = 0;
    if (bluetooth && bluetooth.available === true && !bluetooth.devicePaired) {
      const deviceName = bluetooth.deviceName || "the workled device";
      out.hint = `Macro requires Bluetooth. Pair the device as a BLE HID keyboard (device name: ${deviceName}) and ensure it is connected.`;
    } else {
      out.hint =
        'workled server reachable. If the LED stays off, run set_brightness(128) or use the device switch.';
    }
  } else if (out.clients.some((c) => c.enabled === false)) {
    out.hint = "workled is configured but disabled. Set enabled=true or set WORKLED_MCP_URL.";
  } else if (out.clients.some((c) => !c.url)) {
    out.hint = "workled server has no `url`. Add `url` in your agent config or set WORKLED_MCP_URL.";
  } else {
    if (bluetooth && bluetooth.available === false) {
      out.hint = `Device unreachable: verify power and Wi-Fi, or use the IP address instead of the .local name. Bluetooth is also unavailable: ${bluetooth.error || "no Bluetooth adapter detected"}.`;
    } else {
      out.hint =
        "Device unreachable: verify power and Wi-Fi, or use the IP address instead of the .local name.";
    }
  }

  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.exitCode;
}

if (process.argv[1]) {
  const isMain = fileURLToPath(import.meta.url) === process.argv[1];
  if (isMain) {
    const sub = process.argv[2];
    if (sub === "hook") {
      // runHookMode never rejects (internal try/catch/finally guarantees a
      // single "{}" on stdout + status 0); this catch is only a safety net.
      runHookMode().catch((err) => {
        console.warn(`[workled] hook error: ${err && err.message}`);
      });
    } else if (sub === "status") {
      runStatusMode().catch((err) => {
        console.warn(`[workled] status error: ${err && err.message}`);
        process.exitCode = 1;
      });
    }
  }
}
