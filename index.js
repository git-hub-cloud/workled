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
// CLI hook mode for hermes (short-lived, stdin JSON):
//   node index.js hook [--event <name>]
// Reads the hook payload from stdin, maps the event to a state, sends it over
// MCP (awaiting completion so the process stays alive), and prints `{}`.
// The event->state mapping is unified across all hook-based clients.
//
// Works with the workled MCP server over streamable HTTP. Discovery order:
//   WORKLED_MCP_URL env -> opencode config (mcp.*.url).

import { homedir } from "os";
import { join, resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { stripJsonc, hermesHome, sleep, dshHome, traeCodeUserDir } from "./utils.js";

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
//   client  - "<name>" identifier (e.g., "opencode", "kilo")
//   key     - top-level key that holds the server map (mcp / mcpServers); the
//             hermes YAML reader resolves "mcp_servers" internally
//   format  - json (JSONC tolerated via stripJsonc) | yaml
//   path    - resolved lazily so $HERMES_HOME is always read at call time,
//             never frozen at load.
//   type    - default `type` written for a fresh workled MCP entry; only set
//             for clients that require an explicit transport declaration
//             (opencode/kilo/workbuddy use "remote"). Clients that infer the
//             transport from `url` (openclaw, pi, hermes) omit it.
export const MCP_SOURCES = [
  // opencode
  { client: "opencode", key: "mcp", format: "json", type: "remote", path: () => join(HOME, ".config", "opencode", "opencode.json") },
  { client: "opencode", key: "mcp", format: "json", type: "remote", path: () => join(HOME, ".config", "opencode", "opencode.jsonc") },
  // kilo (opencode fork)
  { client: "kilo", key: "mcp", format: "json", type: "remote", path: () => join(HOME, ".config", "kilo", "kilo.jsonc") },
  // openclaw
  { client: "openclaw", key: "mcp", format: "json", path: () => join(HOME, ".openclaw", "openclaw.json") },
  // pi
  { client: "pi", key: "mcp", format: "json", path: () => join(HOME, ".pi", "mcp.json") },
  // workbuddy (JSON, mcpServers key, ~/.workbuddy/mcp.json; Claude Code
  // compatible, so remote servers declare type: "remote")
  { client: "workbuddy", key: "mcpServers", format: "json", type: "remote", path: () => join(HOME, ".workbuddy", "mcp.json") },
  // hermes (YAML)
  { client: "hermes", key: "mcp_servers", format: "yaml", path: () => join(hermesHome(), "config.yaml") },
  // dsh (DeepSeek Harness): workled is installed as a proper bundle under
  // <dsh-home>/profiles/web/node_modules/workled/, registered in the web
  // profile's package.json dsh.profile.bundles, with a config-override row
  // in cordis.patch.yml (id: workled, name: workled, config: {url, timeout,
  // enabled}). format: "dsh-patch" triggers the dedicated parser in loadMcpServers
  // that extracts config.url + enabled.
  { client: "dsh", key: "mcp", format: "dsh-patch", path: () => join(dshHome(), "profiles", "web", "cordis.patch.yml") },
  // traecode (VSCode fork): global MCP config at <user-data>/User/mcp.json
  // (the VSCode convention TraeCode inherits). HTTP-type workled server is
  // declared bare `{ url, enabled }` — no `type` field. The lifecycle hooks
  // live separately in ~/.trae-cn/hooks.json (see skill-install.mjs).
  { client: "traecode", key: "mcpServers", format: "json", path: () => join(traeCodeUserDir(), "User", "mcp.json") },
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
  hermes: {
    help: "hooks  -> <hermes-home>/config.yaml (~/.hermes on unix, %LOCALAPPDATA%\\hermes on Windows) + reminder in AGENTS.md",
  },
  pi: {
    label: "extension",
    dest: () => join(HOME, ".pi", "agent", "extensions", "workled", "index.ts"),
    agents: () => join(HOME, ".pi", "AGENTS.md"),
  },
  workbuddy: {
    help: "mcp    -> ~/.workbuddy/mcp.json (mcpServers.workled)   + SKILL.md (protocol already loaded)",
  },
  dsh: {
    help: "plugin -> <dsh-home>/profiles/web/node_modules/workled (bundle) + profile patch -> <dsh-home>/profiles/web/cordis.patch.yml (native Cordis plugin, calls workled directly over HTTP) + reminder in AGENTS.md",
  },
  traecode: {
    help: "mcp    -> <user-data>/User/mcp.json (global mcpServers.workled) + hooks -> ~/.trae-cn/hooks.json",
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

// Fixed patterns treated as "waiting for user input" by the openclaw/pi
// adapters. Covers the common naming conventions used by agent toolkits
// (AskUserQuestion, AskUserConfirm, choose_option, select_choice,
// prompt_input, permission_approval etc.) so input detection fires on
// every interactive tool regardless of client spelling.
export function getInputTools() {
  return ["question", "confirm", "ask", "choose", "select", "prompt", "input", "approval", "questionnaire"];
}

// Input-tool detection for the openclaw/pi adapters. Matches by substring
// (case-insensitive) so tools like "AskUserQuestion" or "ask_question" hit
// the fixed "question" pattern — an exact `includes(name)` would never fire
// for those names and the waiting state would stay dark.
export function isInputTool(name) {
  if (!name || typeof name !== "string") return false;
  return getInputTools().some((t) => name.toLowerCase().includes(t.toLowerCase()));
}

// Decide the effective MCP URL when (re)writing a workled server entry.
// Never downgrade a working URL to the `<device-name>` placeholder: if the
// incoming URL is the placeholder but an existing real URL is present, keep
// the real one. Pure helper shared by skill-install.mjs and the test suite.
export function resolveMergedUrl(existingUrl, incomingUrl) {
  const isPlaceholder = (u) => typeof u === "string" && u.includes("<device-name>");
  return isPlaceholder(incomingUrl) && existingUrl && !isPlaceholder(existingUrl)
    ? existingUrl
    : incomingUrl;
}

// Decide the `type` field for a workled MCP entry when (re)writing config.
// An existing `type` wins (a client may use a different transport spelling or
// the user customized it); otherwise the source's default `type` is applied.
// Returns null when neither exists, so the caller omits the field entirely
// rather than writing an empty `type`. Pure helper shared by skill-install.mjs
// and the test suite.
export function resolveMcpType(existingType, defaultType) {
  if (existingType) return existingType;
  if (defaultType) return defaultType;
  return null;
}

// Pure decision for the status hint. The traecode install writes the workled
// server into the GLOBAL MCP config (<user-data>/User/mcp.json), so MCP needs
// only a reload — unless the URL is the <device-name> placeholder, which the
// user must still replace. The lifecycle hooks are written to
// <home>/.trae-cn/hooks.json but must also be enabled manually in
// Settings → Hooks to fire. Returns the reminder text when the traecode client
// is in scope (the user filtered to it, or a traecode entry is present),
// otherwise "". Accepts an optional list of scanned client entries so a
// traecode entry can also trigger the reminder.
export function traecodeReminderText({ clientPrefix = null, clients = [] } = {}) {
  const traecodeFilter = !clientPrefix || String(clientPrefix).startsWith("traecode");
  const hasTraecodeEntry =
    Array.isArray(clients) &&
    clients.some((c) => c && c.client && String(c.client).startsWith("traecode"));
  if (!(traecodeFilter || hasTraecodeEntry)) return "";
  return "traecode: verify the device-name in Settings → MCP (reload to pick up the config) and enable the workled hooks in Settings → Hooks for agent-state tracking.";
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
const seenUserMessages = new Set();
let seenMessagesCleanedAt = Date.now();
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
    if (s.patchManaged) continue; // legacy mark; superseded by bespoke parsers
    const srcPath = s.path();
    if (s.format === "dsh-patch") {
      // dsh bespoke parser: cordis.patch.yml top-level YAML array. Look for a
      // `- insert:` block whose descendent rows contain `- id: workled`, then
      // extract `config: {url, enabled}` scalar fields. Also probe the
      // vendored plugin dir to report install status.
      const pluginDir = join(dshHome(), "plugins", "workled");
      const pluginInstalled = existsSync(pluginDir) && existsSync(join(pluginDir, "src", "index.js"));
      if (!existsSync(srcPath)) {
        // Even when no patch file exists, surface a "ghost" workled entry so
        // diagnoseStatus can distinguish "patch missing (not installed)" from
        // "no workled entry in patch". pluginInstalled=false below doubles as
        // the install signal.
        servers.push({
          name: "workled",
          client: s.client,
          path: srcPath,
          server: { url: null, enabled: false, _dshPluginInstalled: pluginInstalled, _dshPatchExists: false },
        });
        continue;
      }
      try {
        const text = readFileSync(srcPath, "utf8");
        const parsed = dshWorkledPluginFromPatch(text);
        if (parsed) {
          servers.push({
            name: "workled",
            client: s.client,
            path: srcPath,
            server: {
              url: parsed.url,
              enabled: parsed.enabled !== false,
              type: "remote",
              _dshPluginInstalled: pluginInstalled,
              _dshPatchExists: true,
            },
          });
        } else {
          servers.push({
            name: "workled",
            client: s.client,
            path: srcPath,
            server: { url: null, enabled: false, _dshPluginInstalled: pluginInstalled, _dshPatchExists: true, _dshWorkledRow: false },
          });
        }
      } catch {
        /* unreadable patch file: skip */
      }
      continue;
    }
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

// Parse a dsh `cordis.patch.yml` (top-level YAML array of `- insert:` rows)
// and extract the {url, enabled} config from the row whose inserted id is
// `workled` (the native Cordis plugin). Returns null when no such row is
// present. Scalar values use stripValue() for consistency with the hermes parser.
function dshWorkledPluginFromPatch(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  // Accept both indent styles: 4-space "    - id: X" and 6-space "      - id: X".
  const ID_RE = new RegExp(`^\\s{4,6}-\\s*id:\\s*workled\\s*$`);
  let i = 0;
  while (i < lines.length) {
    if (!/^-\s*insert:\s*$/.test(lines[i])) { i++; continue; }
    const start = i + 1;
    let end = start;
    while (end < lines.length && !/^-\s/.test(lines[end])) end++;
    for (let k = start; k < end; k++) {
      if (!ID_RE.test(lines[k])) continue;
      const idIndentMatch = lines[k].match(/^(\s*)/);
      const idIndent = idIndentMatch ? idIndentMatch[1].length : 6;
      let url = null;
      let enabled = undefined;
      let row = k + 1;
      while (row < end) {
        const r = lines[row];
        const lead = r.match(/^(\s*)/);
        if (!lead || r.trim() === "") { row++; continue; }
        if (lead[1].length <= idIndent) break; // next sibling "- id: ..."
        const cfgUrl = r.match(/^\s*url:\s*(.+?)\s*$/);
        if (cfgUrl) url = stripValue(cfgUrl[1].trim());
        const cfgEnabled = r.match(/^\s*enabled:\s*(.+?)\s*$/);
        if (cfgEnabled) enabled = stripValue(cfgEnabled[1].trim());
        row++;
      }
      return { url, enabled };
    }
    i = end;
  }
  return null;
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
// devicePaired, deviceNames, error }. On unsupported platforms or missing
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
// `devicePaired` / `deviceNames` are workled-specific: they report ONLY the
// workled device(s) (name matches HomeAnt-* or workled-* prefix) so the
// macro-readiness hint is accurate. A non-workled device never masquerades as
// paired (fixes #1 — Linux fallback path previously promoted the first
// arbitrary BT device to "paired"). When several workled devices are paired,
// `deviceNames` lists them all (deduplicated).
export async function probeBluetooth(timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  const result = {
    available: null,
    powered: false,
    devicePaired: false,
    deviceNames: [],
    error: null,
  };

  // Regex shared by every platform probe. Device broadcasts use names like
  // "HomeAnt-A919" or "workled-1234"; OS-level paired lists often carry the
  // same name, optionally with HID suffixes. Match anywhere (not just ^)
  // because some hosts prepend "BLE " or append " (Keyboard)" to the name.
  const WORKLED_NAME_RE = /(?:HomeAnt|workled)[-_]?[A-Za-z0-9]*/i;

  try {
    if (process.platform === "win32") {
      // Windows: three-tier probe with progressive fallback.
      //
      //  Tier 1 (preferred): Get-CimInstance Win32_PnPEntity — gives us
      //    HardwareID strings that carry the raw Bluetooth device name in
      //    the format `BTHENUM\{UUID}_<device-mac>#`, plus a ConfigManager
      //    status code where 0 == device present and working. This is the
      //    most reliable source of the workled device name on Windows
      //    because FriendlyName is often localised ("Bluetooth HID Device").
      //  Tier 2 (powered): check the BTHPORT service AND the radio state
      //    via the registry. PnP Status == "OK" only means the driver is
      //    loaded (fixes #3 — previously it was conflated with "radio on").
      //  Tier 3 (FriendlyName last-resort name match): keep the
      //    FriendlyName regex probe as a final fallback so an older Windows
      //    version that happens to set FriendlyName correctly is still
      //    covered (fixes #2 — now it's one probe among many, not the
      //    only way to detect a paired workled).

      try {
        // --- Tier 1: CIM PnP entities (adapter + device name) ------------
        const cimCmd =
          "@(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | " +
          "Where-Object { $_.PNPClass -in @('Bluetooth','BluetoothLE') -or $_.Service -eq 'BTHLE' -or $_.Service -eq 'BTHPORT' } | " +
          "Select-Object Name,FriendlyName,HardwareID,PNPClass,Status,ConfigManagerErrorCode | ConvertTo-Json -Compress)";
        let parsed = [];
        try {
          const { stdout: cimOut } = await execWithRetry(
            "powershell",
            ["-NoProfile", "-Command", cimCmd],
            { timeout: timeoutMs }
          );
          const trimmed = cimOut.trim();
          if (trimmed) parsed = JSON.parse(trimmed);
        } catch {
          parsed = [];
        }
        if (!Array.isArray(parsed)) parsed = parsed ? [parsed] : [];

        // Adapter present = any Bluetooth class entry (regardless of status)
        // that isn't just a virtual enumerator.
        const adapterEntries = parsed.filter((e) =>
          /^Bluetooth/i.test(String(e.PNPClass || ""))
        );
        result.available = adapterEntries.length > 0;

        // Adapter working = at least one entry with CM error code 0 (OK).
        const adapterWorking = adapterEntries.some((e) => {
          const cmErr = Number(e.ConfigManagerErrorCode);
          const statusOk = String(e.Status || "").toLowerCase() === "ok";
          return cmErr === 0 || statusOk;
        });

        // --- Tier 2: powered — BTHPORT service + radio registry hint -----
        // Query the Bluetooth Windows Service state; "Running" means the
        // radio stack is up. Without this the PnP driver status can be
        // "OK" even when the user turned the radio off in Action Center.
        let serviceRunning = false;
        try {
          const { stdout: svcOut } = await execWithRetry(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              "(Get-Service -Name BTHPORT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status) -as [string]",
            ],
            { timeout: timeoutMs }
          );
          serviceRunning = svcOut.trim().toLowerCase() === "running";
        } catch {
          // service probe blocked — infer powered only from adapter working
        }
        result.powered = serviceRunning || adapterWorking;

        // --- Tier 3: workled device name (HardwareID > Name > FriendlyName)
        // HardwareID entries look like:
        //   BTHENUM\{00001812-0000-1000-8000-00805f9b34fb}_LOCALMFG&0000
        //   BTHENUM\\Dev_<6-hex-byte-mac>...
        // But more importantly, the raw device enumeration name for HID
        // over BLE sometimes embeds the advertised name. When it doesn't,
        // we fall back to checking the Name and FriendlyName fields with
        // the prefix regex so manually-assigned FriendlyNames still work.
        // Additionally, scan *all* PnP entities, not just Bluetooth class —
        // the HID side of a paired BLE keyboard often shows up under class
        // "HIDClass" / "Keyboard" / "Mouse" with the real device name in
        // FriendlyName and a BTHENUM HardwareID parent. Collect every match
        // (a single device can match via Name AND FriendlyName, so dedupe).
        const matchedDevices = new Set();
        for (const e of parsed) {
          const haystack = [
            e.Name,
            e.FriendlyName,
            ...(Array.isArray(e.HardwareID) ? e.HardwareID : []),
          ]
            .filter(Boolean)
            .map(String)
            .join(" | ");
          const m = haystack.match(WORKLED_NAME_RE);
          if (m) matchedDevices.add(m[0]);
        }
        // Last-resort FriendlyName sweep across ALL classes (covers the
        // case where the CIM query accidentally filtered the HID side out,
        // but a non-Bluetooth class entry still has a friendly name like
        // "HomeAnt-A919 Keyboard"). Only run when Tier 1 found nothing.
        if (matchedDevices.size === 0) {
          try {
            const { stdout: hidOut } = await execWithRetry(
              "powershell",
              [
                "-NoProfile",
                "-Command",
                "Get-PnpDevice -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FriendlyName",
              ],
              { timeout: timeoutMs }
            );
            const names = hidOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            for (const n of names) {
              const m = n.match(WORKLED_NAME_RE);
              if (m) matchedDevices.add(m[0]);
            }
          } catch {
            // ignored — last resort only
          }
        }
        if (matchedDevices.size > 0) {
          result.devicePaired = true;
          result.deviceNames = [...matchedDevices];
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
          const matched = new Set();
          for (const l of lines) {
            if (!WORKLED_NAME_RE.test(l)) continue;
            const m = l.match(/address:\s*([^\s,]+)/i);
            const nameMatch = l.match(WORKLED_NAME_RE);
            matched.add(nameMatch ? nameMatch[0] : (m ? m[1] : l.split(",")[0]?.trim() || null));
          }
          if (matched.size > 0) {
            result.devicePaired = true;
            result.deviceNames = [...matched];
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
          const matched = new Set();
          for (const d of devices) {
            if (
              !WORKLED_NAME_RE.test(d.device_name || "") &&
              !WORKLED_NAME_RE.test(d.device_type || "")
            ) {
              continue;
            }
            const nm = String(d.device_name || "").match(WORKLED_NAME_RE);
            matched.add(nm ? nm[0] : (d.device_name || null));
          }
          if (matched.size > 0) {
            result.devicePaired = true;
            result.deviceNames = [...matched];
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
          // `bluetoothctl devices` lines: "AA:BB:CC:DD:EE:FF DeviceName"
          // Only accept a device whose name matches the workled prefix.
          // Fixes #1: the previous else-if branch promoted ANY paired
          // device (earbuds, mouse) to "workled paired" when no match
          // was found — that branch is now removed entirely.
          const { stdout: devOut } = await execFileAsync("bluetoothctl", ["devices"], {
            timeout: timeoutMs,
          });
          const lines = devOut.trim().split(/\r?\n/).filter(Boolean);
          const matched = new Set();
          for (const l of lines) {
            if (!WORKLED_NAME_RE.test(l)) continue;
            const m = l.match(WORKLED_NAME_RE);
            matched.add(m ? m[0] : (l.split(/\s+/).slice(2).join(" ") || null));
          }
          if (matched.size > 0) {
            result.devicePaired = true;
            result.deviceNames = [...matched];
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
  const now = Date.now();

  // Single shared cache for the resolved URL. On a cache miss we make the
  // priority decision ONCE and store the winning URL in workledUrl — so the
  // env-override reachability check and the final URL share ONE expiry and ONE
  // code path instead of two parallel caches. WORKLED_MCP_URL wins only when it
  // actually answers (probed with the same probeReachable every other client
  // uses); a set-but-unreachable override falls back to the configured URL so
  // it never breaks the live LED.
  if (workledUrl === null || now >= workledUrlExpiry) {
    const envUrl = process.env.WORKLED_MCP_URL;
    if (envUrl && (await probeReachable(envUrl)).reachable) {
      workledUrl = envUrl;
      workledUrlExpiry = now + WORKLED_URL_TTL_MS;
      return envUrl;
    }
    const candidates = getWorkledCandidates(clientPrefix);
    if (candidates.length === 0) {
      // Nothing resolved; force a re-eval on the next call instead of caching a
      // dead null.
      workledUrl = null;
      workledUrlExpiry = 0;
      return null;
    }
    // Pick the first configured URL directly, without probing (the server is
    // stateless); a failed send calls invalidateDiscovery to re-read the config.
    workledUrl = candidates[0].url;
    workledUrlExpiry = now + WORKLED_URL_TTL_MS;
  }
  return workledUrl;
}

// Forget every cached URL/candidate so the next discovery re-reads the config
// files from disk. Called when a send fails so a device that went offline (or a
// config change) is picked up immediately instead of after the full URL TTL.
function invalidateDiscovery() {
  workledUrl = null;
  workledUrlExpiry = 0;
  cachedCandidates = null;
  candidatesExpiry = 0;
}

let pendingState = null;
let senderRunning = false;
// Track flush promises for CLI hook mode. Each queued flush is tagged with
// the state that was pending at enqueue time so sendLoop can settle only the
// promises whose target state has actually been processed (fixes #6:
// previously a single completed state settled every queued flush regardless
// of which state each caller was waiting for).
const flushPromises = [];
// { state, resolve, reject }[]
//
// The last state actually delivered via MCP (set only on a successful send)
// AND the monotonic timestamp of that send. Dedup only fires when the
// incoming state matches lastSentState AND the last send was within the
// recent dedup window — otherwise an identical state across turns is sent
// so the device can reset animations (fixes #7).
let lastSentState = null;
let lastSentStateAtMs = 0;
const SAME_STATE_DEDUP_WINDOW_MS = 200;

// Pure, side-effect-free predicate that decides whether an incoming state
// should be deduplicated against the last successfully delivered state.
// Exposed for unit tests (and re-used by setAgentState below) so the 200 ms
// short-window rule of #7 is locked down: a repeat state is only suppressed
// when it matches the last sent state, the queue is empty, AND the previous
// send happened within the dedup window. Any repeat state after the window
// is delivered so the device can restart breath/pulse animations.
export function shouldDedupState(state, ctx) {
  const dedup = ctx.dedupWindowMs ?? SAME_STATE_DEDUP_WINDOW_MS;
  if (state !== ctx.lastSentState) return false;
  if (ctx.pendingState !== null && ctx.pendingState !== undefined) return false;
  if (typeof ctx.lastSentStateAtMs !== "number") return false;
  if (typeof ctx.nowMs !== "number") return false;
  return ctx.nowMs - ctx.lastSentStateAtMs < dedup;
}

// Pure version of resolveFlushPromisesForState (fixes #6). Given an array of
// flush entries `{ state: string|null, resolve, reject }` and a just-processed
// `state`, removes and resolves every entry whose target state matches — an
// entry with state=null means "wait for queue drain" so it only matches
// state=null. Returns the count of settled entries so tests can assert that
// entries tagged with a DIFFERENT state remain in-flight for a later settle.
export function drainFlushPromisesForState(list, state, result) {
  let settled = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (entry.state === null || entry.state === state) {
      list.splice(i, 1);
      entry.resolve(result);
      settled++;
    }
  }
  return settled;
}

// Settle flush promises whose target state matches the just-processed one.
// Thin wrapper over the pure helper above — see that helper for the #6 note.
function resolveFlushPromisesForState(state, result) {
  drainFlushPromisesForState(flushPromises, state, result);
}
// Reject every remaining flush promise (sender-loop teardown path).
function rejectAllFlushPromises(err) {
  while (flushPromises.length > 0) {
    const entry = flushPromises.shift();
    entry.reject(err);
  }
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
        resolveFlushPromisesForState(state, result);
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
          lastSentStateAtMs = Date.now();
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts - 1 && pendingState === null) {
            await sleepWithJitter(baseDelay, attempt);
          }
        }
      }
      // Resolve only flush promises waiting for THIS state
      const result = { state, sent, error: lastErr, superseded };
      resolveFlushPromisesForState(state, result);
      if (lastErr) {
        // give up on this state; no resend later. A dead device or a changed
        // config should be re-discovered immediately, so drop the cached URL
        // and candidate list for the next event.
        invalidateDiscovery();
        // console.warn(`[workled] setAgentState(${state}) failed after ${maxAttempts} attempts: ${lastErr.message || lastErr}`);
      }
    }
    // After the outer while-loop exits (pendingState became null) we know the
    // queue is fully drained. Flush any remaining "wait for drain" entries
    // (state === null) that weren't settled by a specific state match.
    const drainResult = { state: null, sent: true, error: null, superseded: false };
    resolveFlushPromisesForState(null, drainResult);
  } finally {
    senderRunning = false;
    // Reject any stragglers if sender exits unexpectedly (shouldn't happen)
    rejectAllFlushPromises(new Error("Sender loop exited unexpectedly"));
  }
}

function setAgentState(state) {
  // Short-window dedup: only skip when the same state was successfully sent
  // VERY recently AND no other state is queued. This lets legitimate repeat
  // requests (new turn, animation reset, question → answered → back to
  // thinking all resolve to "thinking" but separated by "waiting") reach the
  // device so it can restart breath / pulse effects. A tight 200 ms window
  // still collapses accidental double-fires from clients that emit duplicate
  // lifecycle events in quick succession.
  const now = Date.now();
  if (shouldDedupState(state, { lastSentState, lastSentStateAtMs, nowMs: now, pendingState })) {
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

  // Capture the state that is currently queued (or being sent) so the flush
  // promise only settles when THAT specific state is actually processed.
  // null means "wait for full queue drain" — used when sender is mid-flight
  // with no new pending item but we still want to wait for the running loop
  // to come all the way back to idle.
  const targetState = pendingState !== null ? pendingState : null;

  // Resolves when the target state (or queue drain) settles; the timeout timer
  // is cleared as soon as flush settles so short-lived hook processes do not
  // linger.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`flushState timeout after ${FLUSH_TIMEOUT_MS}ms`)),
      FLUSH_TIMEOUT_MS
    );
    flushPromises.push({
      state: targetState,
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
    "Maps opencode agent lifecycle events (thinking/idle/waiting/error) to the workled MCP set_agent_state tool driving the LED strip.",
  async register(ctx) {
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
          // permission.asked -> waiting (tool approval popup shown);
          // permission.replied -> thinking (resolved).
          if (event.type === "permission.asked" || event.type === "question.asked") {
            setAgentState("waiting");
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
        try {
          // Substring, case-insensitive match (isInputTool) so renamed tool
          // variants (ask_question vs AskUserQuestion) still light up `waiting`.
          const toolName = input && input.tool ? String(input.tool) : "";
          if (toolName && isInputTool(toolName)) {
            setAgentState("waiting");
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
    "Maps OpenClaw agent lifecycle events (thinking/idle/waiting/error) to the workled MCP set_agent_state tool driving the LED strip.",
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

    // Tool call that needs a user decision -> waiting
    api.on("before_tool_call", async (event) => {
      try {
        const name =
          (event && (event.toolName || event.tool || event.name)) || "";
        if (isInputTool(name)) {
          setAgentState("waiting");
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
    "Maps pi agent lifecycle events (thinking/idle/waiting/error) to the workled MCP set_agent_state tool driving the LED strip.",
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

    let lastWasWaiting = false;

    pi.on("tool_call", async (event) => {
      // Best-effort input detection: pi has no built-in question tool, but
      // extensions may register interactive tools. Match by tool name.
      const name =
        (event && (event.toolName || event.tool || event.name)) || "";
      const isInput = isInputTool(name);

      if (isInput) {
        setAgentState("waiting");
        lastWasWaiting = true;
      } else if (lastWasWaiting) {
        // Previous tool was an input tool (waiting), now a regular tool runs -> thinking
        setAgentState("thinking");
        lastWasWaiting = false;
      }
    });

    // Note: pi's "input" event fires when USER submits input, not when agent asks.
    // It does NOT map to waiting state. The waiting state is triggered by
    // the agent calling input tools (question, ask, confirm, questionnaire, etc.).
    //
    // Pi has NO built-in permission prompts (docs: "No permission popups.").
    // Custom permission flows must be built via extensions (see confirm-destructive.ts).

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

// ---- CLI hook mode (hermes) -------------------------------------------

// Event name -> state, unified across every hook-based client (hermes).
// Event names are unique per client so no conflicts arise; the same mapping
// serves all of them.
//
// PreToolUse maps to "tool": it resolves to "waiting" only when the payload
// references an input tool (AskUserQuestion etc., checked by extractToolName),
// otherwise it is a no-op. PostToolUse maps to "thinking" — after any tool
// returns the agent resumes working, so the LED returns to the working state.
//
// NOTE (WorkBuddy/CodeBuddy): the host fires PreToolUse AND PostToolUse for
// AskUserQuestion at the moment the USER ANSWERS, NOT when the question is
// rendered. So a hook can never light "waiting" during the AskUserQuestion
// wait window. The agent MUST call set_agent_state("waiting") itself BEFORE
// rendering a question (see SKILL.md). The only render-time hook signal the
// host offers is Notification, which fires when a permission/approval dialog
// is SHOWN (resolved via payload.notification_type, see "notification" below).
const HOOK_MAP = {
  // WorkBuddy (Claude Code-compatible hooks in ~/.workbuddy/settings.json)
  UserPromptSubmit: "thinking",
  // Notification fires when a dialog is SHOWN (render time), not after the
  // user answers. Resolved via payload.notification_type:
  //   permission_prompt -> waiting (tool approval dialog displayed)
  //   idle_prompt       -> idle   (session idle >60s, fallback for Stop)
  //   auth_success/...  -> no-op
  Notification: "notification",
  // hermes (camelCase)
  Stop: "idle",
  PreInvocation: "thinking",
  PostInvocation: "thinking",
  PreToolUse: "tool",
  PostToolUse: "thinking",
  // hermes shell-hook events (snake_case)
  pre_llm_call: "thinking",
  post_llm_call: "idle",
  pre_tool_call: "tool",
  pre_approval_request: "waiting",
  post_approval_response: "thinking",
  on_session_start: "thinking",
  on_session_end: "idle",
  subagent_start: "thinking",
  subagent_stop: "thinking",
  // dsh native Cordis events (bridge-source-validated; see
  // packages/core/agent-loop + packages/core/tools in deepseek-harness).
  // Default install path: a native dsh Cordis plugin (dsh-plugin/src) calls
  // workled DIRECTLY over HTTP (no shell hook hop). These entries remain so
  // a user who prefers the shell-hook bridge can also route raw Cordis
  // event names through the hook CLI path.
  "agent/session-start": "thinking",
  "agent/pre-step": "thinking",
  "tools/pre-execute": "tool",
  "tools/post-execute": "thinking",
  "agent/turn-stopping": "idle",
  "subagent/start": "thinking",
  "subagent/end": "thinking",
  // Additional Claude Code hook events that dsh's @deepseek-ai/dsh-hooks-claude-code
  // bridge supports (dsh runs CC hook config verbatim — see its packages/hooks).
  // Harmless for other clients, which never emit these events.
  SessionStart: "thinking",
  SubagentStart: "thinking",
  SubagentStop: "thinking",
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
    return "waiting";
  }
  if (target === "notification") {
    // CodeBuddy/workbuddy Notification hook input carries notification_type.
    // Only the dialog-shown types map to a state; auth_success and anything
    // unknown are no-ops so the LED is not disturbed by incidental notices.
    const ntype = (payload && (payload.notification_type || payload.notificationType)) || "";
    if (ntype === "permission_prompt") return "waiting";
    if (ntype === "idle_prompt") return "idle";
    return null;
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

    // Read the hook JSON payload from stdin (hermes may pass the event name via
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
      // The timeout timer must be clearable so the hook process exits as soon
      // as the state send settles. Without the clearTimeout below the ref'd
      // timer keeps the event loop alive for the full WORKLED_HOOK_TIMEOUT_MS,
      // which makes the host (WorkBuddy) treat every hook as timed out and
      // block the user prompt (HookBlockedError).
      let timeoutTimer = null;
      try {
        const result = await Promise.race([
          flushState().then((r) => {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            return r;
          }),
          new Promise((resolve) => {
            timeoutTimer = setTimeout(
              () => resolve({ state, sent: false, superseded: false, timeout: true }),
              WORKLED_HOOK_TIMEOUT_MS
            );
          }),
        ]);
        if (!result.sent && !result.superseded && !result.timeout) {
          console.warn(`[workled] hook: state ${result.state} not sent: ${result.error && result.error.message}`);
        }
      } catch (err) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
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
    // Bounded safety net: if the host keeps stdin open (or some socket never
    // settles) the process would otherwise hang forever. This cap is far beyond
    // the flush budget so it never truncates a legitimate in-flight send.
    setTimeout(() => process.exit(0), FLUSH_TIMEOUT_MS + 5000).unref();
  }
}

// ---- status mode (diagnostics) ---------------------------------------------

function isFatalNetworkError(err) {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  const code = err.code || (err.cause && err.cause.code) || "";
  const hardCodes = ["ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ERR_INVALID_URL"];
  if (hardCodes.includes(code)) return true;
  if (msg.includes("enotfound") || msg.includes("econnrefused") || msg.includes("ehostunreach") || msg.includes("invalid url") || msg.includes("fetch failed")) return true;
  return false;
}

// Reachability probe: a bare stateless tools/call to get_agent_state. No
// initialize handshake or session needed (the server serves stateless
// requests), and it also verifies the endpoint is really a workled server:
// only workled knows the get_agent_state tool. Reuses rpc() so error handling
// stays in one place; any throw (HTTP/JSON-RPC/network) means unreachable.
// Retries DEFAULT_MAX_ATTEMPTS times with backoff and reports which attempt
// succeeded so `status` can distinguish a flaky-but-working link from a dead
// one.
async function probeReachable(url, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  if (!url || typeof url !== "string" || url.includes("<device-name>")) {
    return { reachable: false, error: "placeholder URL", attempt: 0 };
  }
  let lastErr = null;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    try {
      await rpc(url, "tools/call", { name: "get_agent_state", arguments: {} }, timeoutMs);
      return { reachable: true, error: null, attempt };
    } catch (err) {
      lastErr = err;
      if (isFatalNetworkError(err)) {
        break;
      }
      if (attempt < DEFAULT_MAX_ATTEMPTS) {
        await sleepWithJitter(DEFAULT_RETRY_DELAY_MS, attempt - 1);
      }
    }
  }
  return {
    reachable: false,
    error: (lastErr && lastErr.message) || String(lastErr),
    attempt: attemptsMade,
  };
}

// status: scan every client config source, keep only sources declaring a
// `workled` server, and probe each unique URL with a bare stateless
// tools/call.
// `clients` is omitted entirely when no workled server is configured.
async function runStatusMode() {
  const out = { hint: "", ok: false, exitCode: 1 };
  const startedAt = Date.now();
  // Progress goes to stderr so stdout stays a clean JSON for the install flow
  // to parse; the step-by-step log also proves the process is alive while the
  // Bluetooth/network probes (which can take seconds) are running.
  const log = (msg) => console.error(`[workled] status: ${msg}`);

  log("scanning agent configs...");

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
    const entry = {
      client: s.client,
      path: s.path,
      enabled: s.server.enabled !== false,
      url: s.server.url || null,
    };
    // dsh-only install flags: allow the final status report to distinguish
    // "patch present but URL placeholder" from "plugin vendored" from "both
    // missing" without a second filesystem probe.
    for (const k of ["_dshPluginInstalled", "_dshPatchExists", "_dshWorkledRow"]) {
      if (k in s.server) entry[k] = s.server[k];
    }
    entries.push(entry);
  }
  log(`found ${entries.length} workled entry(ies)`);

  // Pre-compute dsh diagnosis so the "entries=0" early return and all later
  // hint branches can append it uniformly.
  function dshDiagnosis() {
    const pool = entries.length > 0 ? entries : [];
    const dshEntries = pool.filter((e) => e.client.startsWith("dsh"));
    if (dshEntries.length === 0) return null;
    const parts = [];
    for (const c of dshEntries) {
      const f = [];
      if (c._dshPluginInstalled === true) f.push("plugin=installed");
      else if (c._dshPluginInstalled === false) f.push("plugin=MISSING");
      if (c._dshPatchExists === true && c._dshWorkledRow === false) f.push("patch=NO workled row");
      else if (c._dshPatchExists === true) f.push("patch=ok");
      else if (c._dshPatchExists === false) f.push("patch=MISSING");
      if (!c.url) f.push("url=MISSING");
      else if (c.url.includes("<device-name>")) f.push("url=placeholder");
      parts.push(`[dsh] ${f.join(" · ")} (${c.path})`);
    }
    return parts.join("; ");
  }
  const dshDiag = dshDiagnosis();

  // The traecode install writes global MCP to <user-data>/User/mcp.json;
  // surface the reload/enable reminder (via the pure helper) whenever the
  // traecode client is in scope.
  const appendTraecodeNote = () => {
    const note = traecodeReminderText({ clientPrefix, clients: out.clients });
    if (note) out.hint = out.hint ? `${out.hint} ${note}` : note;
  };

  if (entries.length === 0) {
    out.hint = clientPrefix
      ? `No \`workled\` server configured for client "${clientPrefix}". Add it under \`mcp\` in that client's config or set WORKLED_MCP_URL.`
      : "No `workled` server configured. Add it under `mcp` in your agent config or set WORKLED_MCP_URL.";
    if (dshDiag) out.hint += ` For dsh: ${dshDiag}.`;
    appendTraeNote();
    out.duration_ms = Date.now() - startedAt;
    log(`done in ${out.duration_ms}ms (no workled server configured)`);
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.exitCode;
    return;
  }

  log("probing Bluetooth...");
  const bluetooth = await probeBluetooth().catch(() => ({
    available: false,
    powered: false,
    devicePaired: false,
    deviceNames: [],
    error: "Bluetooth probe failed",
  }));
  out.bluetooth = bluetooth;
  const btDeviceNames = bluetooth.deviceNames && bluetooth.deviceNames.length
    ? bluetooth.deviceNames
    : [];
  log(
    `Bluetooth ${bluetooth.available === true ? "available" : "unavailable"}` +
      (btDeviceNames.length > 0
        ? `, paired device(s): ${btDeviceNames.map((n) => `'${n}'`).join(", ")}`
        : "")
  );

  // Probe each unique URL once, in parallel. Distinct URLs can be checked
  // concurrently; per-URL retries (up to 3 with backoff) stay inside
  // probeReachable. Keeps `status` fast when many clients share configs.
  const urls = [
    ...new Set(entries.filter((e) => e.url && e.enabled).map((e) => e.url)),
  ];
  log(`probing ${urls.length} unique URL(s)...`);
  const results = new Map(
    await Promise.all(urls.map(async (u) => [u, await probeReachable(u)]))
  );
  log("URL probes finished");

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
    // dsh-only install metadata: plugin vendored / patch file exists / workled
    // row is present. Plain entries (JSON/YAML) omit these.
    for (const k of ["_dshPluginInstalled", "_dshPatchExists", "_dshWorkledRow"]) {
      if (k in e) entry[k] = e[k];
    }
    return entry;
  });

  if (out.clients.some((c) => c.reachable)) {
    out.ok = true;
    out.exitCode = 0;
    if (bluetooth && bluetooth.available === true && !bluetooth.devicePaired) {
      let hint = "Macro requires Bluetooth. Pair the device as a BLE HID keyboard.";
      if (btDeviceNames.length > 0) {
        hint += ` Found: ${btDeviceNames.join(", ")}.`;
      } else {
        hint += " Device not found — scan for devices whose name starts with 'HomeAnt' or 'workled' in your OS Bluetooth settings.";
      }
      hint += " Ensure it is connected.";
      out.hint = hint;
    } else {
      out.hint =
        "workled server reachable. If the LED stays off: check brightness (set_brightness(128) or use the device switch); " +
        "if MCP was just configured, restart the agent/session so it loads the new config; " +
        "some agents also require manually allowing/trusting the MCP connection before they use it.";
    }
    if (dshDiag) out.hint += ` For dsh: ${dshDiag}.`;
  } else if (out.clients.some((c) => c.enabled === false)) {
    out.hint = "workled is configured but disabled. Set enabled=true or set WORKLED_MCP_URL.";
    if (dshDiag) out.hint += ` For dsh: ${dshDiag}.`;
  } else if (out.clients.some((c) => !c.url)) {
    out.hint = "workled server has no `url`. Add `url` in your agent config or set WORKLED_MCP_URL.";
    if (dshDiag) out.hint += ` For dsh: ${dshDiag}.`;
  } else {
    if (bluetooth && bluetooth.available === false) {
      out.hint = `Device unreachable: verify power and Wi-Fi, or use the IP address instead of the .local name. Bluetooth is also unavailable: ${bluetooth.error || "no Bluetooth adapter detected"}.`;
    } else {
      let hint = "Device unreachable: verify power and Wi-Fi, or use the IP address instead of the .local name.";
      if (btDeviceNames.length > 0) {
        hint += ` Paired device(s): ${btDeviceNames.join(", ")}.`;
      }
      out.hint = hint;
    }
    if (dshDiag) out.hint += ` For dsh: ${dshDiag}.`;
  }

  // Surface the reload/enable reminder whenever the traecode client is in scope
  // (no-op otherwise). The helper decides internally from the --client filter
  // and the scanned entries, and appends on top of whatever reachable/disabled/
  // unreachable hint was chosen above.
  appendTraecodeNote();

  out.duration_ms = Date.now() - startedAt;
  log(`done in ${out.duration_ms}ms (ok=${out.ok})`);
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.exitCode;
}

if (process.argv[1]) {
  const selfPath = fileURLToPath(import.meta.url);
  // The installed (global) copy is invoked via a different absolute path than
  // the source/workspace copy (e.g. C:\Users\<u>\.agents\skills\workled vs the
  // workspace .agents\skills\workled), so a strict full-path comparison wrongly
  // yields isMain=no and silently skips the hook/status dispatch. Fall back to
  // the resolved basename so the entry file boots regardless of install path.
  const isMain =
    (process.argv[1] && resolve(process.argv[1]) === resolve(selfPath)) ||
    (process.argv[1] && resolve(process.argv[1]).toLowerCase().replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ===
      resolve(selfPath).toLowerCase().replace(/\\/g, "/").split("/").filter(Boolean).at(-1));
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
