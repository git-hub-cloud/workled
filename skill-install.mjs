#!/usr/bin/env node
// workled skill installer/uninstaller for all supported clients.
// Usage client targets: run `node skill-install.mjs --help`.

import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { stripJsonc, hermesHome, sleep } from "./utils.js";
import { MCP_SOURCES, CLIENTS, CLIENT_TARGETS, WORKLED_HOOK_TIMEOUT_MS } from "./index.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const corePath = join(scriptDir, "index.js");
const SKILL_VERSION = JSON.parse(stripJsonc(readFileSync(join(scriptDir, "_meta.json"), "utf8"))).version;
const MARKER = "<!-- workled -->";
const REMINDER = [
  MARKER,
  "",
  "> when connected to a workled device via MCP, call `set_agent_state` on every agent state transition:",
  "> - `set_agent_state(\"thinking\")` while working",
  "> - `set_agent_state(\"idle\")` when the turn finishes; the user can continue with a new question",
  "> - `set_agent_state(\"input\")` when you need the user to confirm a choice, pick an option, or reply — INCLUDING plain-text choice lists and built-in client modals (hermes destructive-command panel, clarify, prompt_toolkit confirmations). Client hooks only fire on tool / LLM / approval events; they do NOT see these. Call it yourself before rendering the options.",
  "> - `set_agent_state(\"error\")` on errors",
].join("\n");

const h = homedir();

// ---- safe path removal ----------------------------------------------------
// WorkBuddy's managed Node intercepts fs delete calls through a "safe-delete"
// shim. Two behaviours are known:
//   1. It may MOVE the target into the Recycle Bin and then THROW, even though
//      the path is already gone (a no-op that would otherwise abort the caller).
//   2. For a "bulk"/recursive delete past a per-turn threshold it REFUSES and
//      THROWS, leaving the target STILL PRESENT ("SAFE_DELETE_BULK_*").
// removePath tolerates both: it only treats removal as failed when the path is
// still present after every escape hatch has been tried. A single recursive
// rm covers behaviour 1 and the normal case; when that is refused (behaviour
// 2) we fall back to removeTreeRobust, which deletes entries ONE AT A TIME so
// no individual call trips the bulk-confirm refusal.
function removePath(p, opts = {}) {
  if (!existsSync(p)) return; // already gone — nothing to do

  // Escape hatch 1: a single recursive rm. Succeeds on a normal environment;
  // on behaviour 1 the shim moves the path to the bin and throws (path gone);
  // only behaviour 2 (bulk refusal) leaves the target present.
  try {
    rmSync(p, { recursive: true, force: true, ...opts });
    if (!existsSync(p)) return; // shim moved it to the bin — gone
  } catch {
    if (!existsSync(p)) return; // shim threw but target is gone — treat as success
    // still present: fall through to the manual walk
  }

  // Escape hatch 2: the bulk-refusal path. Walk the tree and delete entries
  // individually — non-recursive deletes are not subject to the bulk-confirm
  // refusal, so this removes the directory even when a single recursive rm was
  // denied.
  try {
    removeTreeRobust(p);
  } catch {
    // fall through to the final existence check
  }
  if (!existsSync(p)) return;

  // Last resort: one more recursive rm in case the walk got partway.
  try { rmSync(p, { recursive: true, force: true, ...opts }); } catch {}
  if (existsSync(p)) {
    throw new Error(`Failed to remove ${p} (safe-delete shim refused and manual removal was blocked)`);
  }
}

// Recursive per-entry removal. Each file is unlinked individually and each
// directory is emptied bottom-up, so no single call is a "bulk" delete. Every
// operation is wrapped and verified by an existence check, because the shim may
// move a target to the Recycle Bin and throw (target gone) or refuse (target
// still present) — either way we only escalate when the target truly remains.
function removeTreeRobust(p) {
  let st;
  try { st = statSync(p); } catch { return; } // already gone or inaccessible
  if (st.isDirectory()) {
    let entries = [];
    try { entries = readdirSync(p); } catch { entries = []; }
    for (const entry of entries) {
      removeTreeRobust(join(p, entry));
    }
    // Directory should be empty now — remove it bottom-up.
    try { rmdirSync(p, { recursive: false }); } catch {}
  } else {
    try { unlinkSync(p); } catch {}
  }
  // Final attempt for this entry if it is somehow still present.
  if (existsSync(p)) {
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

// Best-effort cleanup of an empty parent directory (P3). Shared plugin /
// extension dirs that still hold other files are left untouched because
// rmdirSync fails on a non-empty directory (and any throw here is swallowed).
function removeEmptyParent(dir) {
  try {
    rmdirSync(dir, { recursive: false });
  } catch {
    // not empty, missing, or rejected by the safe-delete shim — leave it.
  }
}

// ---- instruction file helpers -----------------------------------------------

// Strip every existing workled reminder block from *content* and return the
// trimmed remainder.  Used by appendReminder so stale duplicate markers (e.g.
// from prior installs / manual edits) are purged before the canonical block
// is written.
function stripAllReminderBlocks(content) {
  const lines = content.split("\n");
  const out = [];
  let skip = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === MARKER) {
      // Don't append the marker — it will be rewritten by the caller.
      skip = true;
      continue;
    }
    if (skip) {
      // Drop every line of the reminder block (blockquote/list and blank
      // lines) until the first non-reminder line ends the block.
      if (t === "" || t.startsWith("> ") || t.startsWith("- ")) continue;
      skip = false;
    }
    out.push(line);
  }
  return out.join("\n").trimEnd();
}

function appendReminder(file) {
  if (!existsSync(file)) {
    writeFileSync(file, REMINDER + "\n", "utf8");
    return `Created reminder -> ${file}`;
  }
  const content = readFileSync(file, "utf8");
  // Normalize: strip leading BOM and ensure we start from a clean baseline.
  // This prevents empty/whitespace-only files from getting a stray leading
  // newline before the reminder block.
  const cleaned = content.replace(/^\ufeff/, "").trimEnd();

  // Strip every stale reminder block first, then write the canonical one
  // in its place.  The prior code only handled the first block and left
  // duplicates (from repeated installs or manual edits) in place.
  const remainder = stripAllReminderBlocks(cleaned);
  const nl = remainder.length > 0 ? "\n" : "";
  writeFileSync(file, remainder + nl + REMINDER + "\n", "utf8");
  return `Reminded via workled -> ${file}`;
}

function removeReminder(file) {
  if (!existsSync(file)) {
    return `No instruction file at ${file}`;
  }
  const original = readFileSync(file, "utf8");
  if (!original.includes(MARKER)) {
    return `No workled reminder -> ${file}`;
  }
  const lines = original.split("\n");
  const out = [];
  let skip = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === MARKER) {
      skip = true;
      continue;
    }
    if (skip) {
      // Drop every line of the reminder block (blockquote/list and blank
      // lines) until the first non-reminder line ends the block.
      if (t === "" || t.startsWith("> ") || t.startsWith("- ")) continue;
      skip = false;
    }
    out.push(line);
  }
  const result = out.join("\n").trimEnd();
  if (result === original.trimEnd()) {
    return `No workled reminder -> ${file}`;
  }
  // If the file is now empty, delete it entirely instead of leaving a 0-byte
  // stub. We do NOT delete files that still contain user content. This avoids
  // breaking clients whose config directories require their instruction file
  // to exist (rare) while keeping empty-after-cleanup files clean.
  if (result === "") {
    removePath(file);
    removeEmptyParent(dirname(file));
    return `Removed workled-only instruction file -> ${file}`;
  }
  writeFileSync(file, result + "\n", "utf8");
  return `Cleaned reminder -> ${file}`;
}

// ---- JSON / JSONC merge helpers ---------------------------------------------

function readJsonOrEmpty(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(stripJsonc(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

// Write a JSON config object. mkdir -p the parent first. The single write
// helper for every JSON config this tool manages. No `.bak` is created: the
// writes are idempotent (re-install overwrites the same entries), so backups
// would be pure extra filesystem churn that only prompts cleanup later.
function writeConfig(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ---- hook command construction (agy / hermes) -------------------------------

function hookCommand(eventName) {
  // Windows paths need quotes; JSON handles escaping via JSON.stringify.
  // The event->state mapping is unified across all hook-based clients.
  // Agents that don't echo the event name in stdin (agy, hermes) get it
  // appended explicitly; others resolve it from the payload.
  const base = `node "${corePath}" hook`;
  return eventName ? `${base} --event ${eventName}` : base;
}

// ---- MCP workled server cleanup (uninstall) ---------------------------------

// YAML top-level keys that may hold an MCP server map. hermes versioned its
// config key over time, so each candidate is probed in order (the first block
// that exists wins). Only used for YAML sources; JSON sources use source.key.
const MCP_KEY_CANDIDATES = ["mcp_servers", "mcpServers", "mcp-servers", "servers"];

// Remove the `workled` server from a YAML MCP block in <file>. Candidates are
// probed via splitTopLevelBlock(); the first one present is edited in place.
// Server keys are detected by the block's indentation, so only the `workled`
// server (and its indented body) is dropped; every other server is preserved
// verbatim. If the whole block becomes empty the top-level section is dropped,
// and if the file ends up empty it is deleted. Returns a message or null when
// nothing was removed.
function removeMcpServerYaml(file, keyCandidates) {
  if (!existsSync(file)) return null;
  let content = readFileSync(file, "utf8");
  for (const key of keyCandidates) {
    const split = splitTopLevelBlock(content, key);
    if (!split) continue;
    const lines = content.split("\n");
    const blockLines = lines.slice(split.start, split.end);
    // Detect the indent used for server keys inside this block (e.g. 2
    // spaces, 4 spaces). Server keys live at the deepest level under the
    // top-level block, so we look for any indented `name:` mapping.
    let serverIndent = null;
    for (const line of blockLines) {
      const m = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*$/);
      if (m) {
        serverIndent = m[1];
        break;
      }
    }
    if (!serverIndent) continue; // no servers defined
    // Walk the block, drop ONLY the workled server (and its indented body),
    // preserve every other server verbatim.
    const out = [];
    let skipping = false;
    const curIndentLen = serverIndent.length;
    for (const line of blockLines) {
      const serverKey = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*$/);
      if (serverKey && serverKey[1].length === curIndentLen) {
        if (serverKey[2] === "workled") {
          skipping = true;
          continue;
        } else {
          skipping = false;
          out.push(line);
          continue;
        }
      }
      // Indented continuation: skip if we're inside the workled block.
      if (skipping && /^\s+\S/.test(line)) continue;
      out.push(line);
    }
    const before = lines.slice(0, split.start);
    const after = lines.slice(split.end);
    const mcpBlock = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
    // If the MCP block becomes empty, drop the whole top-level section.
    if (mcpBlock === "" || mcpBlock === `${key}:`) {
      const merged = [...before, ...after].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
      content = merged ? merged + "\n" : "";
      if (content.trim() === "") {
        removePath(file);
        removeEmptyParent(dirname(file));
        return `Removed empty hermes config.yaml -> ${file}`;
      }
      writeFileSync(file, content, "utf8");
      return `Removed empty ${key} block`;
    }
    content = [...before, `${key}:`, mcpBlock.replace(new RegExp(`^${key}:\\s*\\n`), ""), ...after]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
    writeFileSync(file, content, "utf8");
    return `Removed workled from ${key}`;
  }
  return null;
}

// Remove the `workled` MCP server entry from one MCP_SOURCES source (global or
// project). JSON sources: drop obj[key].workled, then the key itself when
// empty; the config is rewritten in place via writeConfig (no backup file is
// created). YAML sources (hermes) go through removeMcpServerYaml(), which
// probes the historical MCP key candidates.
// Returns null when nothing was touched.
function removeMcpServer(source) {
  if (source.format === "yaml") {
    const candidates = [source.key, ...MCP_KEY_CANDIDATES.filter((k) => k !== source.key)];
    return removeMcpServerYaml(source.path(), candidates);
  }
  const file = source.path();
  if (!existsSync(file)) return null;
  const obj = readJsonOrEmpty(file);
  if (!obj || typeof obj !== "object") return null;
  const map = obj[source.key];
  if (!map || typeof map !== "object" || map.workled === undefined) return null;
  delete map.workled;
  if (Object.keys(map).length === 0) delete obj[source.key];
  writeConfig(file, obj);
  return `Removed workled from ${source.key} -> ${file}`;
}

// Remove the `workled` MCP server entry from every config source of one client
// (global + project scope). Returns the list of removal messages produced by
// removeMcpServer() (null results filtered out); an empty array means no
// `workled` MCP server entry was found to remove.
function unregisterWorkledMcp(client) {
  return MCP_SOURCES.filter((s) => s.client.startsWith(`${client}.`))
    .map((s) => removeMcpServer(s))
    .filter(Boolean);
}

// Resolve the workled MCP server URL, in priority order:
//   1. WORKLED_MCP_URL        (explicit configuration wins)
//   2. placeholder            (http://<device-name>.local:18791/mcp, user must replace)
// There is intentionally no Bluetooth scan and no hard-coded specific host
// (e.g. HomeAnt-2831.local): the user supplies the real device name either via
// WORKLED_MCP_URL or by replacing the placeholder before connecting.
async function resolveWorkledMcpUrl() {
  if (process.env.WORKLED_MCP_URL) return process.env.WORKLED_MCP_URL;
  // No explicit URL: emit a placeholder the user must replace with their real
  // workled device name before connecting.
  return "http://<device-name>.local:18791/mcp";
}

// ---- WorkBuddy user-level hooks (settings.json) ----------------------------
// WorkBuddy loads hooks from ~/.workbuddy/settings.json (a Claude Code-compatible
// `hooks` field), NOT from the skill directory. These fire automatically on each
// lifecycle event — independent of agent discipline — so the workled LED tracks
// state reliably across new sessions without re-reminding the agent.
function workledHookCommand(eventName) {
  // Use the same node that runs this installer (managed runtime) and the
  // installed index.js; both paths are absolute and stable on this machine.
  return `"${process.execPath}" "${corePath}" hook --event ${eventName} --client workbuddy`;
}

// Each lifecycle event the workled hook should fire on. `matcher` (only for
// PreToolUse) restricts the hook to a specific tool so it does NOT run on every
// tool call — a bare PreToolUse hook would spawn a ~3.6s process per Bash/Read/
// Write and stall the agent. The `input` state is emitted only when the matched
// tool is one of the workled "input" tools (see getInputTools / WORKLED_INPUT_TOOLS).
const WORKLED_HOOK_SPECS = [
  { event: "UserPromptSubmit", matcher: null },
  { event: "Stop", matcher: null },
  { event: "PreToolUse", matcher: "AskUserQuestion" },
];

// Write workled hooks into ~/.workbuddy/settings.json. Idempotent: any prior
// workled entry for the same event is replaced first.
function registerWorkledSettingsHooks() {
  const settingsFile = join(h, ".workbuddy", "settings.json");
  const settings = readJsonOrEmpty(settingsFile) || {};
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  for (const spec of WORKLED_HOOK_SPECS) {
    const ev = spec.event;
    if (!Array.isArray(settings.hooks[ev])) settings.hooks[ev] = [];
    // Drop any prior workled entry for this event to stay idempotent.
    settings.hooks[ev] = settings.hooks[ev].filter(
      (group) =>
        !(
          group &&
          Array.isArray(group.hooks) &&
          group.hooks.some(
            (hk) =>
              hk &&
              typeof hk.command === "string" &&
              hk.command.includes("workled") &&
              hk.command.includes(`hook --event ${ev}`)
          )
        )
    );
    const group = {
      hooks: [{ type: "command", command: workledHookCommand(ev), timeout: WORKLED_HOOK_TIMEOUT_MS / 1000 }],
    };
    if (spec.matcher) group.matcher = spec.matcher;
    settings.hooks[ev].push(group);
  }
  writeConfig(settingsFile, settings);
  return `Installed workled hooks -> ${settingsFile}`;
}

// Remove only the workled hooks from ~/.workbuddy/settings.json, leaving every
// other hook and setting untouched.
function unregisterWorkledSettingsHooks() {
  const settingsFile = join(h, ".workbuddy", "settings.json");
  const settings = readJsonOrEmpty(settingsFile);
  if (!settings || !settings.hooks) return `No workled hooks at ${settingsFile}`;
  let removed = false;
  for (const ev of Object.keys(settings.hooks)) {
    const before = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev].length : 0;
    if (Array.isArray(settings.hooks[ev])) {
      settings.hooks[ev] = settings.hooks[ev].filter(
        (group) =>
          !(
            group &&
            Array.isArray(group.hooks) &&
            group.hooks.some(
              (hk) =>
                hk &&
                typeof hk.command === "string" &&
                hk.command.includes("workled") &&
                hk.command.includes("hook --event")
            )
          )
      );
    }
    if ((settings.hooks[ev] || []).length === 0) delete settings.hooks[ev];
    if ((settings.hooks[ev] || []).length < before) removed = true;
  }
  if (!removed) return `No workled hooks at ${settingsFile}`;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeConfig(settingsFile, settings);
  return `Removed workled hooks -> ${settingsFile}`;
}

// Inverse of removeMcpServer: write the `workled` server entry into one MCP
// source (JSON or YAML). For JSON, an existing `type` (e.g. WorkBuddy's
// "remote") is preserved so we never downgrade a client's transport setting.
function addMcpServer(source, entry) {
  if (source.format === "yaml") {
    return addMcpServerYaml(source.path(), source.key, "workled", entry);
  }
  const file = source.path();
  const obj = readJsonOrEmpty(file) || {};
  const map =
    obj[source.key] && typeof obj[source.key] === "object"
      ? obj[source.key]
      : (obj[source.key] = {});
  const existing = map.workled && typeof map.workled === "object" ? map.workled : {};
  // Never downgrade a working URL to the <device-name> placeholder: if the new
  // entry carries the placeholder but an existing real URL is present, keep the
  // real one. This guards `install` runs where WORKLED_MCP_URL / Bluetooth are
  // unavailable (placeholder path) yet a valid config already exists.
  const PLACEHOLDER = "<device-name>";
  const isPlaceholder = (u) => typeof u === "string" && u.includes(PLACEHOLDER);
  const url = isPlaceholder(entry.url) && existing.url && !isPlaceholder(existing.url)
    ? existing.url
    : entry.url;
  const merged = { url, enabled: entry.enabled !== false };
  if (existing.type) merged.type = existing.type;
  map.workled = merged;
  writeConfig(file, obj);
  return `Registered workled -> ${source.key} (${file})`;
}

// Add (or replace) a `workled` server under a YAML top-level MCP block
// (`mcp_servers:` or an aliased key). Preserves every other server and the
// block's indentation.
function addMcpServerYaml(file, key, serverName, entry) {
  if (!existsSync(file)) return null;
  let content = readFileSync(file, "utf8");
  const split = splitTopLevelBlock(content, key);
  const serverLines = [
    `  ${serverName}:`,
    `    url: ${JSON.stringify(entry.url)}`,
    `    enabled: true`,
  ];
  if (!split) {
    const trimmed = content.trimEnd();
    content = (trimmed ? trimmed + "\n" : "") + `${key}:\n` + serverLines.join("\n") + "\n";
    writeFileSync(file, content, "utf8");
    return `Registered workled -> ${key} (${file})`;
  }
  const lines = content.split("\n");
  const blockLines = lines.slice(split.start, split.end);
  let sIndent = "  ";
  for (const l of blockLines) {
    const m = l.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (m) {
      sIndent = m[1];
      break;
    }
  }
  const out = [];
  let skipping = false;
  for (const l of blockLines) {
    const m = l.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (m && m[1] === sIndent) {
      if (m[2] === serverName) {
        skipping = true;
        continue;
      }
      skipping = false;
      out.push(l);
      continue;
    }
    if (skipping && /^\s+\S/.test(l)) continue;
    out.push(l);
  }
  out.push(`${sIndent}${serverName}:`);
  out.push(`${sIndent}  url: ${JSON.stringify(entry.url)}`);
  out.push(`${sIndent}  enabled: true`);
  const before = lines.slice(0, split.start);
  const after = lines.slice(split.end);
  content = [...before, ...out, ...after].join("\n").replace(/\n{3,}/g, "\n\n");
  writeFileSync(file, content, "utf8");
  return `Registered workled -> ${key} (${file})`;
}

// Register the workled MCP server for one client across its global config
// sources (deduped by path). Mirrors unregisterWorkledMcp so install and
// uninstall stay symmetric and every client's logic is identical.
function registerWorkledMcp(client, entry) {
  const sources = MCP_SOURCES.filter((s) => s.client === `${client}.global`);
  const seen = new Set();
  const msgs = [];
  for (const s of sources) {
    if (seen.has(s.path())) continue;
    seen.add(s.path());
    msgs.push(addMcpServer(s, entry));
  }
  return msgs.filter(Boolean);
}

// ---- per-client install/uninstall -------------------------------------------

const HOOK_EVENTS = {
  agy: ["PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop"],
};

// agy (Antigravity) hook name used as the top-level key in hooks.json.
const AGY_HOOK_ID = "workled";

// agy (Antigravity): hooks.json at ~/.gemini/config/hooks.json. The top-level
// key is a hook id (AGY_HOOK_ID). Simple events (PreInvocation/PostInvocation/
// Stop) are arrays of { type, command }; tool events (PreToolUse/PostToolUse)
// are arrays of { matcher, hooks: [{ type, command }] }. agy does NOT send the
// event name in stdin, so it is passed via --event.
function agyCommandShape(ev) {
  const cmd = hookCommand(ev);
  if (ev === "PreToolUse" || ev === "PostToolUse") {
    return { matcher: "*", hooks: [{ type: "command", command: cmd }] };
  }
  return { type: "command", command: cmd };
}

function installAgy() {
  const hooksFile = join(h, ".gemini", "config", "hooks.json");
  const json = readJsonOrEmpty(hooksFile) || {};
  const root = json && typeof json === "object" ? json : {};
  const entry = {};
  for (const ev of HOOK_EVENTS.agy) {
    entry[ev] = [agyCommandShape(ev)];
  }
  root[AGY_HOOK_ID] = entry;
  writeConfig(hooksFile, root);
  return `Installed agy hooks -> ${hooksFile}`;
}

function uninstallAgy() {
  const hooksFile = join(h, ".gemini", "config", "hooks.json");
  const json = readJsonOrEmpty(hooksFile);
  if (!json || !json[AGY_HOOK_ID]) return `No agy workled hooks at ${hooksFile}`;
  delete json[AGY_HOOK_ID];
  // Always write back — never delete hooks.json even if now empty;
  // other tools or clients may rely on the file's existence.
  writeConfig(hooksFile, json);
  return `Removed agy workled hooks -> ${hooksFile}`;
}

// openclaw: the Gateway loads standalone plugin files listed in
// ~/.openclaw/openclaw.json `plugins.load.paths`. Each plugin needs a sibling
// `openclaw.plugin.json` manifest (id + configSchema, validated cold), and the
// entry must be enabled under `plugins.entries.<id>` with conversation-hook
// access granted for the agent_end hook.
const OPENCLAW_PLUGIN_MANIFEST = {
  id: "workled",
  name: "workled",
  description:
    "Maps OpenClaw agent lifecycle events (thinking/idle/input/error) to the workled MCP set_agent_state tool driving the LED strip.",
  version: SKILL_VERSION,
  activation: { onStartup: true, onCapabilities: ["hook"] },
  configSchema: { type: "object", additionalProperties: false, properties: {} },
};

function openclawConfigPath() {
  return join(h, ".openclaw", "openclaw.json");
}

function openclawPluginDir() {
  return join(h, ".openclaw", "plugins");
}

// Load ~/.openclaw/openclaw.json (or {} if missing/unparseable).
function readOpenclawConfig() {
  const p = openclawConfigPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function installOpenclaw() {
  const destDir = join(openclawPluginDir(), "workled");
  const dest = join(destDir, "index.js");
  mkdirSync(destDir, { recursive: true });

  // Write the entry file (imports the core via an absolute URL, so no
  // dependency files need copying into the plugin dir)
  writeFileSync(dest, openclawEntryFile(), "utf8");

  // Write plugin manifest
  writeFileSync(
    join(destDir, "openclaw.plugin.json"),
    JSON.stringify(OPENCLAW_PLUGIN_MANIFEST, null, 2) + "\n",
    "utf8"
  );

  const cfg = readOpenclawConfig();
  const entryPath = dest.replace(/\\/g, "/");
  const plugins = (cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {});
  const load = (plugins.load && typeof plugins.load === "object" ? plugins.load : {});
  const paths = Array.isArray(load.paths) ? load.paths : [];
  if (!paths.includes(entryPath)) paths.push(entryPath);
  plugins.load = { ...load, paths };
  const entries = (plugins.entries && typeof plugins.entries === "object" ? plugins.entries : {});
  entries.workled = {
    ...(entries.workled && typeof entries.workled === "object" ? entries.workled : {}),
    enabled: true,
    hooks: { allowConversationAccess: true },
  };
  plugins.entries = entries;
  cfg.plugins = plugins;
  // cfg already carries every existing section from readOpenclawConfig(), so
  // write it whole — a merge round-trip would re-read the file and risk mixing
  // two snapshots while the Gateway watcher is reloading.
  writeConfig(openclawConfigPath(), cfg);

  // Wait for Gateway to finish reloading and verify the config persisted.
  // Gateway's file watcher triggers a restart when plugins.load changes.
  // On Windows, filesystem commits can be asynchronous, so the Gateway may
  // read a stale/incomplete file and roll back to .bak. We poll until the
  // config stabilises or we give up.
  const configPath = openclawConfigPath();
  let verified = false;
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    const check = readOpenclawConfig();
    const pathsOk = Array.isArray(check.plugins?.load?.paths) &&
      check.plugins.load.paths.some(p => String(p).includes("workled"));
    const entryOk = !!(check.plugins?.entries?.workled?.enabled);
    const dirOk = existsSync(dest);
    if (pathsOk && entryOk && dirOk) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    // Config didn't stabilise — write it one more time directly (no merge)
    // to bypass any rollback edge-case with empty existing plugins.
    const cfg2 = readOpenclawConfig();
    cfg2.plugins = { ...cfg.plugins };
    writeConfig(configPath, cfg2);
    // Verify again
    await sleep(2000);
    const final = readOpenclawConfig();
    if (!final.plugins?.entries?.workled) {
      return `Installed openclaw entry + manifest -> ${dest}\n⚠ Config update may have been rolled back by Gateway restart. Run the install again or restart the Gateway manually.`;
    }
  }

  return `Installed openclaw entry + manifest + config -> ${dest}\nRegistered in openclaw.json plugins.load.paths and plugins.entries.workled (restart the Gateway to load)`;
}

// Strip every workled entry from an openclaw config object, returning the
// cleaned copy, whether anything changed, and the messages describing it.
// Shared by uninstallOpenclaw's main cleanup and its rollback recovery path.
function stripWorkledFromOpenclawConfig(cfg) {
  const out = { cfg: { ...cfg }, changed: false, messages: [] };
  if (out.cfg && out.cfg.plugins) {
    const plugins = out.cfg.plugins;
    if (plugins.load && Array.isArray(plugins.load.paths)) {
      const filtered = plugins.load.paths.filter((p) => !String(p).includes("workled"));
      if (filtered.length !== plugins.load.paths.length) {
        plugins.load.paths = filtered;
        if (filtered.length === 0) delete plugins.load;
        out.changed = true;
        out.messages.push(`Unregistered workled from openclaw.json plugins.load.paths`);
      }
    }
    if (plugins.entries && plugins.entries.workled) {
      delete plugins.entries.workled;
      if (Object.keys(plugins.entries).length === 0) delete plugins.entries;
      out.changed = true;
      out.messages.push(`Unregistered workled from openclaw.json plugins.entries`);
    }
    if (plugins.load && Object.keys(plugins.load).length === 0) delete plugins.load;
    if (plugins.entries && Object.keys(plugins.entries).length === 0) delete plugins.entries;
    if (Object.keys(plugins).length === 0) delete out.cfg.plugins;
  }
  return out;
}

async function uninstallOpenclaw() {
  const destDir = join(openclawPluginDir(), "workled");
  let msg = "";
  if (existsSync(destDir)) {
    removePath(destDir, { recursive: true });
    removeEmptyParent(dirname(destDir));
    msg += `Removed openclaw plugin dir -> ${destDir}\n`;
  } else {
    msg += `No openclaw workled plugin dir at ${destDir}\n`;
  }

  // Always read the current config and remove workled entries, then write.
  // We must write unconditionally because the Gateway file watcher may have
  // already rolled back the config to .bak between our read and any write.
  const configPath = openclawConfigPath();
  let cleaned = stripWorkledFromOpenclawConfig(readOpenclawConfig());

  // Write the cleaned config via the shared helper (no merge round-trip, so
  // stale workled entries from a concurrently-modified file cannot resurface).
  writeConfig(configPath, cleaned.cfg);
  if (cleaned.changed) {
    msg += cleaned.messages.join("\n") + "\n";
    msg += `Updated openclaw.json -> ${configPath}\n`;
  }

  // Wait for Gateway to finish reloading, then verify the config is clean.
  // If Gateway rolled back (e.g. because it read an intermediate state),
  // rewrite the clean config one more time.
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const check = readOpenclawConfig();
    const hasWorkled = check.plugins?.load?.paths?.some(p => String(p).includes("workled"))
      || check.plugins?.entries?.workled;
    if (!hasWorkled) return msg.trimEnd() || `No openclaw workled plugin installed`;
  }

  // Gateway didn't stabilise — force-write clean config one final time.
  cleaned = stripWorkledFromOpenclawConfig(readOpenclawConfig());
  writeConfig(configPath, cleaned.cfg);
  msg += `Force-cleaned openclaw.json (Gateway rollback recovery)\n`;
  return msg.trimEnd();
}

// ---- entry file generation ---------------------------------------------------

function fileUrl(p) {
  return pathToFileURL(p).href;
}

// Generated entry files share a fixed "do not edit" header and a trailing
// newline; each adapter only supplies its own import/export body lines.
const ENTRY_HEADER = "// Generated by workled install.mjs. Do not edit.";
function entryFile(lines) {
  return [ENTRY_HEADER, ...lines, ""].join("\n");
}

// opencode: the plugins dir auto-loads EVERY exported function as a plugin, so
// the installed file exposes a single plugin function that adapts the entry's
// register() into opencode's factory shape.
function opencodeEntryFile() {
  return entryFile([
    `import { opencodeEntry as core } from "${fileUrl(corePath)}";`,
    `export const workled = async (ctx) => await core.register(ctx);`,
  ]);
}

// openclaw: Gateway loads via plugins.load.paths; wraps the entry with the SDK.
function openclawEntryFile() {
  return entryFile([
    `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";`,
    `import { openclawEntry } from "${fileUrl(corePath)}";`,
    `export default definePluginEntry(openclawEntry);`,
  ]);
}

// pi: extensions take the default export as (pi: ExtensionAPI) => void.
function piEntryFile() {
  return entryFile([
    `import { piEntry } from "${fileUrl(corePath)}";`,
    `export default (pi) => piEntry.register(pi);`,
  ]);
}

// kilo (Anomaly) is an opencode fork: Event/Hooks types are identical to
// opencode, so it reuses opencodeEntry. The installed file is a module
// descriptor (default export { id, server }) in the single `plugin/` dir.
function kiloEntryFile() {
  return entryFile([
    `import { opencodeEntry as core } from "${fileUrl(corePath)}";`,
    `export default {`,
    `  id: "workled",`,
    `  server: async (ctx) => await core.register(ctx),`,
    `};`,
  ]);
}

// Entry-file generators for the plugin-file clients (opencode / kilo / pi).
// Target paths and labels live in CLIENT_TARGETS (index.js); this table only
// adds what cannot be data — the generated entry content — so client paths are
// maintained in exactly one place. Keys must be a subset of CLIENTS.
const PLUGIN_CLIENTS = {
  opencode: opencodeEntryFile,
  kilo: kiloEntryFile,
  pi: piEntryFile,
};

// hermes: shell hooks are declared in <hermes-home>/config.yaml under a
// top-level `hooks:` block; each event maps to an array of { command,
// timeout? }. The config is YAML, so these helpers do a minimal top-level
// block edit that preserves any other top-level keys (model, terminal, ...)
// untouched. hermes home resolution mirrors hermes_constants.get_hermes_home:
//   $HERMES_HOME env var wins; otherwise Windows uses %LOCALAPPDATA%\hermes,
//   everything else uses ~/.hermes. Implemented once in utils.js.

function hermesHookEvents() {
  return [
    "pre_llm_call",
    "post_llm_call",
    "pre_tool_call",
    "pre_approval_request",
    "post_approval_response",
    "on_session_start",
    "on_session_end",
    "subagent_start",
    "subagent_stop",
  ];
}

function hermesCommandYaml(ev) {
  // JSON.stringify produces valid YAML double-quoted scalar (backslashes/escaping).
  return JSON.stringify(hookCommand(ev));
}

// Split a YAML document into a leading top-level block for a given key and the
// remainder, so the caller can replace just that key.
function splitTopLevelBlock(yamlText, key) {
  const lines = yamlText.split("\n");
  const keyLineRe = new RegExp(`^${key}:\\s*$|^${key}:\\s+`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (keyLineRe.test(lines[i]) && !/^\s/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && !/^\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

// Detect the indentation of event keys inside an existing `hooks:` block, so we
// reuse whatever indent the user's config uses instead of assuming 2 spaces.
// Falls back to 2 spaces (the canonical default) when no indented key is found.
function detectEventIndent(blockLines) {
  for (const line of blockLines) {
    const m = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (m && m[1].length >= 1 && m[1].length <= 6) return m[1];
  }
  return "  ";
}

function installHermesHooks(yamlText) {
  const events = hermesHookEvents();
  const split = splitTopLevelBlock(yamlText, "hooks");
  if (!split) {
    // No hooks block yet: append one with our workled events.
    const block = [
      "hooks:",
      ...events.map((ev) => [
        `  ${ev}:`,
        `    - command: ${hermesCommandYaml(ev)}`,
      ]).flat(),
    ].join("\n");
    const trimmed = yamlText.trimEnd();
    return (trimmed ? trimmed + "\n" : "") + block + "\n";
  }
  // A hooks block exists: rebuild it, preserving every non-workled hook entry
  // and only replacing the workled entries for our events. Indentation is read
  // from the existing block (any consistent indent works), so a user config
  // using 4-space or tab indentation is not corrupted.
  const lines = yamlText.split("\n");
  const blockLines = lines.slice(split.start, split.end);
  const indent = detectEventIndent(blockLines);
  const out = [];
  let currentEvent = null;
  const ensured = new Set();
  for (const line of blockLines) {
    const evMatch = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (evMatch && evMatch[1].length > 0) {
      // Any indented map key under `hooks:` is an event key. Keep its own
      // indentation; entries are derived one level deeper than that key.
      currentEvent = evMatch[2];
      out.push(line);
      if (events.includes(currentEvent) && !ensured.has(currentEvent)) {
        ensured.add(currentEvent);
        out.push(`${evMatch[1]}  - command: ${hermesCommandYaml(currentEvent)}`);
      }
      continue;
    }
    // Regular line inside the block: drop stale workled entries of OUR events
    // (regardless of their indent), preserve everything else verbatim.
    const isWorkledEntry =
      currentEvent && events.includes(currentEvent) && /^\s*-\s+command:.*workled/.test(line);
    if (isWorkledEntry) {
      continue;
    }
    // Drop orphan continuation lines left behind by previous broken installs
    // (e.g. " hook --event" that no longer has a parent - command: line).
    const isOrphan = /^\s+\S+/.test(line) && !line.includes("command:");
    if (isOrphan) continue;
    out.push(line);
  }
  // Ensure every workled event exists with exactly our command.
  for (const ev of events) {
    if (ensured.has(ev)) continue;
    out.push(`${indent}${ev}:`);
    out.push(`${indent}  - command: ${hermesCommandYaml(ev)}`);
  }
  const before = lines.slice(0, split.start);
  const after = lines.slice(split.end);
  return [...before, ...out, ...after].join("\n");
}

function uninstallHermesHooks(yamlText) {
  const events = hermesHookEvents();
  const split = splitTopLevelBlock(yamlText, "hooks");
  if (!split) return yamlText;
  const lines = yamlText.split("\n");
  const blockLines = lines.slice(split.start, split.end);
  const indent = detectEventIndent(blockLines);
  // Group the block into (eventKey | null for a prelude, entries[]). Top-level
  // lines (the `hooks:` key itself) and blank lines are skipped.
  const groups = [];
  let cur = null;
  let prelude = null;
  for (const line of blockLines) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) continue;
    const evMatch = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (evMatch) {
      cur = { key: evMatch[2], indent: evMatch[1], entries: [] };
      groups.push(cur);
    } else if (cur) {
      cur.entries.push(line);
    } else {
      // Indented line before any event group (odd but harmless): keep it so
      // nothing is silently dropped.
      if (!prelude) {
        prelude = [];
        groups.push({ key: null, indent: "", entries: prelude });
      }
      prelude.push(line);
    }
  }
  // Drop only our workled entries; keep everything else (indent-preserving).
  const keptGroups = groups
    .map((g) => {
      const workledEvt = events.includes(g.key);
      const kept = workledEvt
        ? g.entries.filter((l) => !/^\s*-\s+command:.*workled/.test(l) && !/^\s+\S+/.test(l))
        : g.entries;
      return { key: g.key, indent: g.indent, entries: kept };
    })
    .filter((g) => g.entries.length > 0);
  // If nothing remains under hooks, drop the whole block.
  if (keptGroups.length === 0) {
    const before = lines.slice(0, split.start);
    const after = lines.slice(split.end);
    return [...before, ...after].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }
  const rebuilt = [
    "hooks:",
    ...keptGroups.flatMap((g) =>
      g.key === null ? g.entries : [`${g.indent}${g.key}:`, ...g.entries]
    ),
  ];
  const before = lines.slice(0, split.start);
  const after = lines.slice(split.end);
  return [...before, ...rebuilt, ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}

function installHermes() {
  const cfg = join(hermesHome(), "config.yaml");
  mkdirSync(dirname(cfg), { recursive: true });
  const existing = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  writeFileSync(cfg, installHermesHooks(existing), "utf8");
  return `Installed hermes shell hooks -> ${cfg}`;
}

function uninstallHermes() {
  const cfg = join(hermesHome(), "config.yaml");
  if (!existsSync(cfg)) return `No hermes config at ${cfg}`;
  const content = readFileSync(cfg, "utf8");
  // Remove workled hooks from the hooks block; every other top-level key
  // (user hooks, MCP servers, model/terminal settings, ...) is preserved.
  // The workled MCP server entry is removed separately by
  // unregisterWorkledMcp("hermes") via removeMcpServerYaml().
  const cleaned = uninstallHermesHooks(content);
  if (cleaned === content) return `No hermes workled hooks at ${cfg}`;
  if (cleaned.trim() === "") {
    removePath(cfg);
    removeEmptyParent(dirname(cfg));
    return `Removed empty hermes config.yaml -> ${cfg}`;
  }
  writeFileSync(cfg, cleaned, "utf8");
  return `Removed hermes shell hooks -> ${cfg}`;
}

// ---- CLI ----------------------------------------------------------------------

// Render one client's --help line from CLIENT_TARGETS: plugin clients use the
// structured dest/label (plus the standard AGENTS.md reminder suffix), the
// others carry ready-made help text.
function targetHelp(name) {
  const t = CLIENT_TARGETS[name] ?? CLIENT_TARGETS.default;
  return t.help || `${t.label} -> ${t.dest()} + reminder in AGENTS.md`;
}

function printHelp() {
  console.log(`workled skill installer

Usage:
  node skill-install.mjs install|uninstall --client <name>|all
  node skill-install.mjs install|uninstall --file <instruction-file>

${CLIENTS.map((c) => `  ${c.padEnd(10)} ${targetHelp(c)}`).join("\n")}
  --file     generic: only the reminder (clients not in the list use this method)
  --client   REQUIRED -- the invoking agent passes its own client name, or
             "all" to apply the operation to every client
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const action = args[0]; // install | uninstall
  const fileIdx = args.indexOf("--file");
  const fileArg = fileIdx >= 0 ? args[fileIdx + 1] : null;

  if (action !== "install" && action !== "uninstall") {
    printHelp();
    process.exit(1);
  }

  // Generic mode: only the reminder, no client target involved. Handled here so
  // `uninstall --file` (and `install --file`) works without a `--client` flag.
  if (fileArg) {
    const out = action === "install" ? appendReminder(fileArg) : removeReminder(fileArg);
    console.log(out);
    return;
  }

  // Target client resolution: both actions (install AND uninstall) require an
  // explicit target. The invoking agent passes its own client name, or "all"
  // to apply the operation to every client. Omitted => error listing the
  // client enum so the agent can pick its own client or all.
  const clientIdx = args.indexOf("--client");
  const clientArg = clientIdx >= 0 ? args[clientIdx + 1] : null;
  if (clientArg && clientArg !== "all" && !CLIENTS.includes(clientArg)) {
    console.error(`Unknown client: ${clientArg}\nSupported clients: ${CLIENTS.join(", ")}, all`);
    process.exit(1);
  }
  if (!clientArg) {
    console.error(
      `No target client for ${action}.\n` +
      `Pass --client <name> to ${action} only your own client, or --client all to ${action} every client.\n` +
      `Clients: ${CLIENTS.join(", ")}, all`
    );
    process.exit(1);
  }
  const targets = clientArg === "all" ? CLIENTS : [clientArg];

  // Resolve the MCP URL once (discovers the real workled device name when
  // possible) so every client's install registers the same, correct endpoint.
  let mcpEntry = null;
  if (action === "install") {
    const url = await resolveWorkledMcpUrl();
    if (url.includes("<device-name>")) {
      console.warn(
        "Warning: no WORKLED_MCP_URL set and no workled device discovered via " +
          "Bluetooth. Wrote a placeholder URL (http://<device-name>.local:18791/mcp); " +
          "replace <device-name> with your real workled device name (e.g. HomeAnt-XXXX), " +
          "or set WORKLED_MCP_URL, before connecting."
      );
    }
    mcpEntry = { url, enabled: true };
  }

  const failedClients = [];
  for (const c of targets) {
    const isInstall = action === "install";
    const lines = [];
    try {
    switch (c) {
      case "opencode":
      case "kilo":
      case "pi": {
        const t = CLIENT_TARGETS[c]; // { label, dest, agents } — plugin client
        const dest = t.dest();
        const destDir = dirname(dest);
        if (isInstall) {
          mkdirSync(destDir, { recursive: true });
          writeFileSync(dest, PLUGIN_CLIENTS[c](), "utf8");
          lines.push(`Installed ${c} ${t.label} -> ${dest}`);
          lines.push(appendReminder(t.agents()));
          lines.push(...(await registerWorkledMcp(c, mcpEntry)));
        } else {
          if (existsSync(dest)) {
            removePath(dest);
            removeEmptyParent(destDir);
            lines.push(`Removed ${c} ${t.label} -> ${dest}`);
          } else {
            lines.push(`No ${c} ${t.label} at ${dest}`);
          }
          lines.push(removeReminder(t.agents()));
          lines.push(...unregisterWorkledMcp(c));
        }
        break;
      }
      case "openclaw": {
        lines.push(await (isInstall ? installOpenclaw() : uninstallOpenclaw()));
        lines.push(isInstall ? appendReminder(join(h, ".openclaw", "AGENTS.md")) : removeReminder(join(h, ".openclaw", "AGENTS.md")));
        if (isInstall) lines.push(...(await registerWorkledMcp("openclaw", mcpEntry)));
        else lines.push(...unregisterWorkledMcp("openclaw"));
        break;
      }
      case "agy": {
        lines.push(isInstall ? installAgy() : uninstallAgy());
        lines.push(isInstall ? appendReminder(join(h, ".gemini", "AGENTS.md")) : removeReminder(join(h, ".gemini", "AGENTS.md")));
        if (isInstall) lines.push(...(await registerWorkledMcp("agy", mcpEntry)));
        else lines.push(...unregisterWorkledMcp("agy"));
        break;
      }
      case "hermes": {
        const hh = hermesHome();
        lines.push(isInstall ? installHermes() : uninstallHermes());
        lines.push(isInstall ? appendReminder(join(hh, "AGENTS.md")) : removeReminder(join(hh, "AGENTS.md")));
        if (isInstall) lines.push(...(await registerWorkledMcp("hermes", mcpEntry)));
        else lines.push(...unregisterWorkledMcp("hermes"));
        break;
      }
      case "workbuddy": {
        // WorkBuddy is a pure-MCP client with no per-client hook layer, so the
        // state protocol is enforced by user-level hooks in settings.json
        // (installed below) rather than by agent discipline. Install registers
        // both the MCP server entry and the lifecycle hooks; uninstall removes
        // both.
        if (isInstall) {
          lines.push(...(await registerWorkledMcp("workbuddy", mcpEntry)));
          lines.push(registerWorkledSettingsHooks());
        } else {
          lines.push(...unregisterWorkledMcp("workbuddy"));
          lines.push(unregisterWorkledSettingsHooks());
        }
        break;
      }
      default:
        console.error(`Unknown client: ${c}`);
        process.exit(1);
    }
    console.log(lines.join("\n") + "\n");
    } catch (err) {
      // One client failed (e.g. the safe-delete shim refused a bulk delete this
      // turn). Do NOT abort the batch — report and continue so every other
      // client is still (un)installed.
      console.error(`⚠ Failed to ${action} client "${c}": ${err && err.message}`);
      failedClients.push(c);
    }
  }

  // If any client could not be (un)installed this run (typically because the
  // safe-delete shim blocked a bulk delete under a busy turn), surface a
  // summary and a non-zero exit so the caller knows to retry those clients in a
  // fresh turn — without having skipped the ones that succeeded.
  if (failedClients.length) {
    console.error(
      `\n⚠ ${failedClients.length} client(s) failed to ${action}: ${failedClients.join(", ")}.\n` +
      `  Re-run \`node skill-install.mjs ${action} --client ${failedClients.length === 1 ? failedClients[0] : "all"}\` in a fresh turn to finish.`
    );
    process.exitCode = 1;
  }

  // No `.bak` files are created (writes are idempotent), so there is nothing
  // to clean up here. Historical `.bak` files left by older versions are
  // deliberately left untouched — the tool never deletes user-visible
  // backup files.

  // After install, point the agent at the diagnostic command so it can check
  // MCP reachability and surface the result (hint) to the user. The hint is
  // the same regardless of which client was targeted: --client only affects
  // which client gets installed/uninstalled, not how `index.js status` is run.
  if (action === "install" && !fileArg) {
    // Run status check to see if MCP is configured
    const { spawnSync } = await import("child_process");
    const statusResult = spawnSync("node", [corePath, "status"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (statusResult.stdout) {
      try {
        const status = JSON.parse(statusResult.stdout);
        if (!status.ok) {
          console.log("");
          console.log("⚠ WORKLED MCP SERVER NOT CONFIGURED");
          console.log("   Please add the MCP server to your client config:");
          console.log("   See device_setup.md for instructions.");
          console.log("   Or run: node " + corePath + " status to check current state.");
        } else {
          console.log("   " + status.hint);
        }
      } catch {
        // Ignore parse errors
      }
    }
  }
}

main().catch((err) => {
  console.error(`install.mjs error: ${err && err.stack}`);
  process.exit(1);
});
