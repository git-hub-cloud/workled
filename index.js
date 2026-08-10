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
import { stripJsonc, hermesHome } from "./utils.js";

const HOME = homedir();

// PLUGIN_VERSION: single-sourced from _meta.json (the skill registry metadata);
// package.json only declares the module type and is not read here.
let PLUGIN_VERSION = "1.0.0";
try {
  const metaPath = join(import.meta.dirname, "_meta.json");
  if (existsSync(metaPath)) {
    PLUGIN_VERSION = JSON.parse(stripJsonc(readFileSync(metaPath, "utf8"))).version || "1.0.0";
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
  // hermes (YAML)
  { client: "hermes.global", key: "mcp_servers", format: "yaml", path: () => join(hermesHome(), "config.yaml") },
];

// Every client the skill installs to. `status` accepts an optional
// `--client <name>` filter that must be one of these. Derived from MCP_SOURCES
// so it stays in sync: to add a client, extend MCP_SOURCES above and add the
// matching install/uninstall branch in skill-install.mjs + SKILL.md.
export const CLIENTS = [...new Set(MCP_SOURCES.map((s) => s.client.split(".")[0]))];

// Per-client install target summary shown by `skill-install.mjs --help`.
// Free-form help text (not derivable from MCP_SOURCES), kept here so all
// client knowledge lives in one file. Keys must match CLIENTS; the `default`
// key is the fallback used by --help for any client not explicitly listed.
export const CLIENT_TARGETS = {
  opencode: "plugin -> ~/.config/opencode/plugins/workled.js  + reminder in AGENTS.md",
  kilo: "plugin -> ~/.config/kilo/plugin/workled.js       + reminder in AGENTS.md",
  openclaw:
    "entry  -> ~/.openclaw/plugins/workled/ + openclaw.plugin.json + openclaw.json (load.paths + entries) + reminder in AGENTS.md",
  agy: "hooks  -> ~/.gemini/config/hooks.json            + reminder in AGENTS.md",
  hermes:
    "hooks  -> <hermes-home>/config.yaml (~/.hermes on unix, %LOCALAPPDATA%\\hermes on Windows) + reminder in AGENTS.md",
  pi: "entry  -> ~/.pi/agent/extensions/workled.ts      + reminder in AGENTS.md",
  default: "installed (targets: see SKILL.md)",
};

const TOOL_NAME = "set_agent_state";
const DEFAULT_RPC_TIMEOUT_MS = 5000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

// Monotonic counter for unique JSON-RPC IDs (batch mode)
let nextRpcId = 1;
function nextRpcIdFn() {
  return nextRpcId++;
}

function getInputTools() {
  return (process.env.WORKLED_INPUT_TOOLS || "question")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithJitter(baseMs, attempt) {
  // Exponential backoff with jitter: base * 2^attempt * (0.5 ~ 1.5)
  const expDelay = baseMs * Math.pow(2, attempt);
  const jitter = expDelay * (0.5 + Math.random());
  return sleep(Math.floor(jitter));
}

let workledUrl = null;
let hookClientPrefix = null;
let projectDir = process.cwd();
const seenUserMessages = new Set();
let seenMessagesCleanedAt = 0;
const SEEN_MESSAGES_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Config candidates cache (parsed server list with name==='workled', enabled, url)
let cachedCandidates = null;
let candidatesExpiry = 0;
const CANDIDATES_TTL_MS = 60 * 1000; // 1 minute

// Session cache for connection reuse (lightweight: one initialize per process,
// then reuse the session id until it expires, avoiding a new session per call).
let cachedSessionId = null;
let cachedUrl = null;
let sessionExpiry = 0;
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Mutex to prevent concurrent initialize (race when several calls detect an expired cache)
let initLock = Promise.resolve();

function withInitLock(fn) {
  const p = initLock.then(fn);
  initLock = p.catch(() => {}); // never reject the lock chain
  return p;
}

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

function loadMcpConfig() {
  const merged = {};
  for (const s of loadMcpServers()) {
    merged[s.name] = s.server;
  }
  return merged;
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

// Helper: extract JSON object or array from response text
function extractJson(text) {
  const trimmed = text.trim();
  // Direct JSON object
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // SSE data lines
  const data = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  if (!data) throw new Error("No JSON data found in response");
  // Try object first, then array (batch mode)
  try {
    return JSON.parse(data);
  } catch {
    // Not valid JSON
    throw new Error(`Invalid JSON: ${data.substring(0, 100)}`);
  }
}

// Does the server know our session? (guarded by initLock for concurrent initialize)
async function ensureSession(url, signal) {
  const now = Date.now();
  if (cachedUrl === url && cachedSessionId && now < sessionExpiry) {
    return cachedSessionId;
  }
  // Invalidate stale cache for this url before re-initializing
  if (cachedUrl === url) {
    cachedSessionId = null;
    cachedUrl = null;
    sessionExpiry = 0;
  }

  await withInitLock(async () => {
    // Double-check after acquiring the lock (another caller may have initialized)
    const now2 = Date.now();
    if (cachedUrl === url && cachedSessionId && now2 < sessionExpiry) {
      return;
    }
    const initRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextRpcIdFn(),
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "workled", version: PLUGIN_VERSION },
        },
      }),
    });
    await initRes.arrayBuffer();
    const sid = initRes.headers.get("mcp-session-id");
    if (sid) {
      cachedSessionId = sid;
      cachedUrl = url;
      sessionExpiry = now2 + SESSION_TTL_MS;
      // notifications/initialized must carry the session id header.
      try {
        await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Mcp-Session-Id": sid,
          },
          signal,
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });
      } catch {
        // best effort; server that no-ops the notification is fine
      }
    }
  });

  if (!cachedSessionId) {
    throw new Error(`MCP initialize did not return a session id: ${url}`);
  }
  return cachedSessionId;
}

// JSON-RPC error codes that signal a server requires (or lost) a session.
const SESSION_REQUIRED_CODES = new Set([-32005, -32006, -32020]);
// Per-URL negotiated transport mode: "stateless" (default) or "session".
// We prefer the stateless mode from the 2026-07-28 spec: never keep/mirror a
// session id. If a server rejects a sessionless request, we fall back to a
// classic session (initialize + Mcp-Session-Id) for that URL and remember it.
const urlMode = new Map();

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
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcIdFn(), method, params }),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

// Does this response mean "this server requires a session id"? A standalone
// sessionless request is refused with HTTP 400 (spec) or a JSON-RPC error in
// the session codes above. Some servers (e.g. this workled device) instead
// answer 200 with a -32600 "initialize must be first interaction" error, which
// also means we must start a session first.
function requiresSession(status, text) {
  if (status === 400 || status === 401 || status === 403) return true;
  try {
    const out = JSON.parse(text);
    const code = out && out.error && out.error.code;
    if (SESSION_REQUIRED_CODES.has(code)) return true;
    if (code === -32600) {
      const reason = JSON.stringify(out.error.data || out.error.message || "");
      if (/initialize|session/i.test(reason)) return true;
    }
  } catch {
    // not JSON; only the HTTP status above can signal a session requirement
  }
  return false;
}

// Send a JSON-RPC request, stateless-first with a session fallback. Session
// negotiation is per-url (urlMode) so once a server is known stateless we never
// pay the initialize round-trip again.
async function rpc(url, method, params, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  if ((urlMode.get(url) || "stateless") === "stateless") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { status, text } = await postJson(url, method, params, controller);
      if (requiresSession(status, text)) {
        // Fall through: re-issue via the session transport below.
        urlMode.set(url, "session");
      } else {
        return extractJson(text);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Session fallback (or forced session transport for this url).
  const maxAuthRetries = 1;
  for (let authAttempt = 0; authAttempt <= maxAuthRetries; authAttempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const sessionId = await ensureSession(url, controller.signal);
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Mcp-Session-Id": sessionId,
      };
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextRpcIdFn(),
          method,
          params,
        }),
        signal: controller.signal,
      });

      // Session expired / unauthorized: drop the cached session and retry once.
      if (res.status === 401 || res.status === 403) {
        cachedSessionId = null;
        cachedUrl = null;
        sessionExpiry = 0;
        if (authAttempt < maxAuthRetries) {
          continue;
        }
        throw new Error(`MCP session auth failed (${res.status}): ${url}`);
      }

      const text = await res.text();
      return extractJson(text);
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable (loop always returns or throws), kept to satisfy the linter.
  return null;
}

// Does this server host the tool? Stateless-first, then the session fallback.
async function hasTool(url, toolName, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS) {
  if ((urlMode.get(url) || "stateless") === "stateless") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { status, text } = await postJson(url, "tools/list", {}, controller);
      if (requiresSession(status, text)) {
        urlMode.set(url, "session");
      } else {
        const out = extractJson(text);
        const tools = (out.result && out.result.tools) || [];
        return tools.some((t) => t.name === toolName);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Session fallback: initialize first, then tools/list.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const initRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextRpcIdFn(),
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "workled-discover", version: PLUGIN_VERSION },
        },
      }),
    });
    await initRes.arrayBuffer();
    const sessionId = initRes.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("No session ID from initialize");

    // Send initialized notification (required before tools/list)
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId,
        },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
    } catch {
      // Best effort; some servers don't require this
    }

    // Call tools/list with session ID
    const listRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Mcp-Session-Id": sessionId,
      },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextRpcIdFn(),
        method: "tools/list",
        params: {},
      }),
    });
    const text = await listRes.text();
    const out = extractJson(text);
    const tools = (out.result && out.result.tools) || [];
    return tools.some((t) => t.name === toolName);
  } finally {
    clearTimeout(timer);
  }
}

async function discoverWorkledUrl(clientPrefix) {
  if (process.env.WORKLED_MCP_URL) return process.env.WORKLED_MCP_URL;
  if (workledUrl) return workledUrl;
  const candidates = getWorkledCandidates(clientPrefix);
  if (candidates.length === 0) return null;

  // Concurrent discovery with Promise.allSettled
  const results = await Promise.allSettled(
    candidates.map(async (c) => {
      const ok = await hasTool(c.url, TOOL_NAME);
      if (ok) return c.url;
      throw new Error("Tool not found");
    })
  );

  for (const res of results) {
    if (res.status === "fulfilled" && res.value) {
      workledUrl = res.value;
      return res.value;
    }
  }
  return null;
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
        while (flushPromises.length > 0) {
          const { resolve } = flushPromises.shift();
          resolve(result);
        }
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
          await rpc(url, "tools/call", { name: TOOL_NAME, arguments: { state_name: state } });
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
      while (flushPromises.length > 0) {
        const { resolve } = flushPromises.shift();
        resolve(result);
      }
      if (lastErr) {
        // give up on this state; no resend later
        console.warn(`[workled] setAgentState(${state}) failed after ${maxAttempts} attempts: ${lastErr.message || lastErr}`);
      }
    }
  } finally {
    senderRunning = false;
    // Reject any remaining flush promises if sender exits unexpectedly
    while (flushPromises.length > 0) {
      const { reject } = flushPromises.shift();
      reject(new Error("Sender loop exited unexpectedly"));
    }
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
async function flushState() {
  // If nothing pending and not running, return immediately
  if (pendingState === null && !senderRunning) {
    return { state: null, sent: true, error: null, superseded: false };
  }

  // Resolves when the current state is sent; the timeout timer is cleared as
  // soon as flush settles so short-lived hook processes do not linger.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("flushState timeout after 15s")),
      15000
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
          seenUserMessages.add(id);
          if (seenUserMessages.size > 200 || Date.now() - seenMessagesCleanedAt > SEEN_MESSAGES_CLEANUP_INTERVAL_MS) {
            seenUserMessages.clear();
            seenMessagesCleanedAt = Date.now();
          }
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
        seenUserMessages.add(id);
        if (seenUserMessages.size > 200 || Date.now() - seenMessagesCleanedAt > SEEN_MESSAGES_CLEANUP_INTERVAL_MS) {
          seenUserMessages.clear();
          seenMessagesCleanedAt = Date.now();
        }
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

function resolveHookState(event, payload) {
  const target = HOOK_MAP[event];
  if (!target) return null;
  if (target === "tool") {
    const toolName = extractToolName(payload);
    if (!toolName || !getInputTools().includes(toolName)) return null;
    return "input";
  }
  return target;
}

async function runHookMode() {
  const argv = process.argv.slice(2);
  const eventIdx = argv.indexOf("--event");
  const eventArg = eventIdx >= 0 ? argv[eventIdx + 1] : null;
  const clientIdx = argv.indexOf("--client");
  const clientArg = clientIdx >= 0 ? argv[clientIdx + 1] : null;
  if (clientArg) hookClientPrefix = clientArg;

  // Read the hook JSON payload from stdin (agy may pass the event name via
  // --event instead).
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
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
    process.stdout.write("{}\n");
    return;
  }
  const state = resolveHookState(event, payload);
  if (state) {
    setAgentState(state);
    try {
      // Await the flush so the short-lived process does not exit before the
      // MCP call completes. flushState has a 15s internal timeout.
      const result = await flushState();
      if (!result.sent && !result.superseded) {
        console.warn(`[workled] hook: state ${result.state} not sent: ${result.error && result.error.message}`);
      }
    } catch (err) {
      console.warn(`[workled] hook flush error: ${err && err.message}`);
    }
  }
  // Always print an empty JSON object so the hook never blocks or denies.
  process.stdout.write("{}\n");
}

// ---- status mode (diagnostics) ---------------------------------------------

// Reachability probe: a bare MCP initialize handshake. Unlike ensureSession it
// does not require a session id, so it reports HTTP-level reachability only.
async function probeReachable(url, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextRpcIdFn(),
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "workled-status", version: PLUGIN_VERSION },
        },
      }),
      signal: controller.signal,
    });
    if (res.ok) return { reachable: true, error: null };
    return { reachable: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, error: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// status: scan every client config source, keep only sources declaring a
// `workled` server, and probe each unique URL with an initialize handshake.
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
    // WORKLED_MED_URL override wins and is reported first.
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
    return entry;
  });

  if (out.clients.some((c) => c.reachable)) {
    out.ok = true;
    out.exitCode = 0;
    out.hint =
      'workled server reachable. If the LED stays off, run set_brightness("128") or use the device switch.';
  } else if (out.clients.some((c) => c.enabled === false)) {
    out.hint = "workled is configured but disabled. Set enabled=true or set WORKLED_MCP_URL.";
  } else if (out.clients.some((c) => !c.url)) {
    out.hint = "workled server has no `url`. Add `url` in your agent config or set WORKLED_MCP_URL.";
  } else {
    out.hint =
      "Device unreachable: verify power and Wi-Fi, or use the IP address instead of the .local name.";
  }

  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.exitCode;
}

if (process.argv[1]) {
  const isMain = fileURLToPath(import.meta.url) === process.argv[1];
  if (isMain) {
    const sub = process.argv[2];
    if (sub === "hook") {
      runHookMode().catch((err) => {
        console.warn(`[workled] hook error: ${err && err.message}`);
        process.stdout.write("{}\n");
      });
    } else if (sub === "status") {
      runStatusMode().catch((err) => {
        console.warn(`[workled] status error: ${err && err.message}`);
        process.exitCode = 1;
      });
    }
  }
}
