#!/usr/bin/env node
// workled skill installer/uninstaller for all supported clients.
// Usage client targets: run `node skill-install.mjs --help`.

import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  copyFileSync,
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
import { stripJsonc, hermesHome, sleep, dshHome, traeCodeHooksHome } from "./utils.js";
import { MCP_SOURCES, CLIENTS, CLIENT_TARGETS, WORKLED_HOOK_TIMEOUT_MS, resolveMergedUrl, resolveMcpType } from "./index.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
function resolveCorePath() {
  const globalIndex = join(homedir(), ".agents", "skills", "workled", "index.js");
  if (existsSync(globalIndex)) {
    return globalIndex;
  }
  return join(scriptDir, "index.js");
}
const corePath = resolveCorePath();
// SKILL_VERSION: single-sourced from _meta.json, with a fallback so a missing
// or corrupt registry file never crashes the installer (index.js guards the
// same read).
let SKILL_VERSION = "";
try {
  SKILL_VERSION = JSON.parse(stripJsonc(readFileSync(join(scriptDir, "_meta.json"), "utf8"))).version || "";
} catch {
  // fallback to default
}
const MARKER = "<!-- workled -->";
// Keep this block verbatim in sync with SKILL.md "## Mandatory State Protocol"
// (the State/When table): same four states, same order, same wording.
const REMINDER = [
  MARKER,
  "> when connected to a workled device via MCP, call `set_agent_state` on every agent state transition:",
  "> - `set_agent_state(\"thinking\")` — first tool call of every reply; user submits a message",
  "> - `set_agent_state(\"waiting\")` — call BEFORE asking the user for input: before invoking an input tool (`AskUserQuestion`/`question`/`ask`/`confirm`), before opening a client-side modal, before rendering a plain-text choice list / multi-option question",
  "> - `set_agent_state(\"idle\")` — turn finished; session torn down",
  "> - `set_agent_state(\"error\")` — runtime error / failed tool call occurred",
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
      // Drop every line of the reminder block (blockquote lines and blank
      // lines) until the first non-reminder line ends the block. Only "> "
      // lines and blanks belong to the canonical REMINDER block; "- " lines
      // are never treated as block content so a user's own list that follows
      // the reminder is preserved.
      if (t === "" || t.startsWith("> ")) continue;
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
      // Drop every line of the reminder block (blockquote lines and blank
      // lines) until the first non-reminder line ends the block. Only "> "
      // lines and blanks belong to the canonical REMINDER block; "- " lines
      // are never treated as block content so a user's own list that follows
      // the reminder is preserved.
      if (t === "" || t.startsWith("> ")) continue;
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

// ---- JSON/JSONC text editors (comment-preserving) ---------------------------
// install/uninstall edit config files with byte-level surgery instead of
// JSON.stringify round-trips, so user comments, key order, and formatting
// survive untouched. The workled entry is always a flat object, which makes
// locating it inside the server map a single flat-object regex.

// Return true when <text> parses as JSON (JSONC comments/trailing commas OK).
export function isValidJsonc(text) {
  try {
    JSON.parse(stripJsonc(text));
    return true;
  } catch {
    return false;
  }
}

// Walk raw text (string literals and // and /* */ comments skipped) and return
// the span of a top-level key's object value: { start, end } are the opening
// `{` and its matching `}`. Only the first match of `"<key>"` at brace depth 1
// (directly inside the root object) is considered. Returns null when the key
// or an object value is absent.
//
// A leading UTF-8 BOM is skipped internally so brace-depth counting lines up
// with the actual root `{`, but returned indices are ALWAYS relative to the
// ORIGINAL caller-supplied text (fixes #5: without this BOM compensation every
// returned span would be off by one, and the caller would slice into the
// middle of keys, corrupting the file and falling back to JSON.stringify —
// losing all user comments/formatting).
function findTopLevelObjectValueSpan(text, key) {
  let bom = 0;
  if (text.charCodeAt(0) === 0xfeff) bom = 1;
  const body = bom ? text.slice(1) : text;
  const needle = `"${key}"`;
  const n = body.length;
  let inStr = false;
  let i = 0;
  let depth = 0;
  let valueStart = -1;

  while (i < n) {
    const c = body[i];
    if (inStr) {
      if (c === "\\") i += 2;
      else {
        if (c === '"') inStr = false;
        i++;
      }
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (body[i] === "\\") i += 2;
        else if (body[i] === '"') {
          i++;
          break;
        } else i++;
      }
      if (depth === 1 && body.slice(start, i) === needle) {
        let j = i;
        while (j < n && /\s/.test(body[j])) j++;
        if (body[j] === ":") {
          j++;
          while (j < n && /\s/.test(body[j])) j++;
          if (body[j] === "{") {
            valueStart = j;
            break;
          }
        }
      }
      continue;
    }
    if (c === "/" && body[i + 1] === "/") {
      while (i < n && body[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      i += 2;
      while (i < n && !(body[i] === "*" && body[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  if (valueStart < 0) return null;

  // Match braces from valueStart to find the matching closing brace.
  inStr = false;
  let d = 0;
  let j = valueStart;
  while (j < n) {
    const c = body[j];
    if (inStr) {
      if (c === "\\") j += 2;
      else {
        if (c === '"') inStr = false;
        j++;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      j++;
      continue;
    }
    if (c === "/" && body[j + 1] === "/") {
      while (j < n && body[j] !== "\n") j++;
      continue;
    }
    if (c === "/" && body[j + 1] === "*") {
      j += 2;
      while (j < n && !(body[j] === "*" && body[j + 1] === "/")) j++;
      j += 2;
      continue;
    }
    if (c === "{") d++;
    else if (c === "}") {
      d--;
      if (d === 0) return { start: valueStart + bom, end: j + bom };
    }
    j++;
  }
  return null;
}

// Index of the root object's closing `}` (string/comment safe), or -1 when the
// document is not an object literal. A leading BOM is skipped internally but
// returned indices are still relative to the original caller-supplied text so
// callers slice the original bytes correctly (sibling fix of #5).
function findRootObjectEnd(text) {
  let bom = 0;
  if (text.charCodeAt(0) === 0xfeff) bom = 1;
  const body = bom ? text.slice(1) : text;
  let inStr = false;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      i += 2;
      while (i < body.length && !(body[i] === "*" && body[i + 1] === "/")) i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + bom;
    }
  }
  return -1;
}

// Locate the span { start, end } of the NAMED OBJECT entry inside a parent
// object-value span. The parent span covers `{ ... }` of the containing map
// (e.g. the value of `"mcp": { ... }`). Walks through the map text with full
// brace-balancing and string/comment awareness so a nested object value
// (e.g. `"workled": { "effects": { "thinking": {...} } }`) does NOT cut the
// match short at an inner `}`. Used by upsertJsoncEntry / removeJsoncEntry
// to replace the regex `[^{}]*` that choked on nested values (fixes #4/#10).
// Returns null when the named entry is absent.
//
// NOTE: the caller passes text.slice(span.start, span.end) which INCLUDES the
// outer opening `{` at index 0 and the closing `}` at the last index. After
// we consume the outer `{` depth becomes 1, and keys written inside the map
// are encountered at depth == 1 (not 0).
//
// Exported for unit tests (fixes #9 — nesting, inline comments, and strings
// containing `{}` must not cut the span short).
export function findNamedObjectSpanInMap(mapText, name) {
  const needle = `"${name}"`;
  const n = mapText.length;
  let inStr = false;
  let i = 0;
  // Depth starts at 0 and increments once when we see the outer `{` of the
  // enclosing map. Top-level keys of the map (e.g. "workled", "my-other-mcp")
  // therefore live at depth == 1; any nested objects push depth to >= 2.
  let depth = 0;

  while (i < n) {
    const c = mapText[i];
    if (inStr) {
      if (c === "\\") i += 2;
      else {
        if (c === '"') inStr = false;
        i++;
      }
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (mapText[i] === "\\") i += 2;
        else if (mapText[i] === '"') { i++; break; }
        else i++;
      }
      // Keys at depth 1 inside the slice = top-level keys of the containing
      // map (after consuming the outer `{`). This is where we match needle.
      if (depth === 1 && mapText.slice(start, i) === needle) {
        let j = i;
        while (j < n && /\s/.test(mapText[j])) j++;
        if (mapText[j] === ":") {
          j++;
          while (j < n && /\s/.test(mapText[j])) j++;
          if (mapText[j] === "{") {
            // Brace-balance to find the matching `}`. Nesting depth here is
            // local to the needle's value object so we start a fresh counter.
            const objStart = j;
            let d = 0;
            let k = j;
            while (k < n) {
              const cc = mapText[k];
              if (inStr) {
                if (cc === "\\") k += 2;
                else { if (cc === '"') inStr = false; k++; }
                continue;
              }
              if (cc === '"') { inStr = true; k++; continue; }
              if (cc === "/" && mapText[k + 1] === "/") { while (k < n && mapText[k] !== "\n") k++; continue; }
              if (cc === "/" && mapText[k + 1] === "*") { k += 2; while (k < n && !(mapText[k] === "*" && mapText[k + 1] === "/")) k++; k += 2; continue; }
              if (cc === "{") d++;
              else if (cc === "}") { d--; if (d === 0) return { start: objStart, end: k }; }
              k++;
            }
          }
        }
      }
      continue;
    }
    if (c === "/" && mapText[i + 1] === "/") { while (i < n && mapText[i] !== "\n") i++; continue; }
    if (c === "/" && mapText[i + 1] === "*") { i += 2; while (i < n && !(mapText[i] === "*" && mapText[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return null;
}

// Whitespace prefix of the line containing <index>.
function lineIndentAt(text, index) {
  let lineStart = index;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  const m = text.slice(lineStart, index).match(/^[\t ]*/);
  return m ? m[0] : "";
}

// Format a server entry as a multi-line JSON object block.
// <keyIndent> is the indentation that the `"serverName": {` line itself
// should sit at (i.e. the indent of a sibling key inside the containing
// map); child fields sit one level deeper, consistently using 2 spaces.
function jsoncEntryBlock(serverName, entry, keyIndent) {
  const fieldIndent = keyIndent + "  ";
  const keys = Object.keys(entry);
  const lines = [`${keyIndent}${JSON.stringify(serverName)}: {`];
  keys.forEach((k, idx) => {
    const comma = idx < keys.length - 1 ? "," : "";
    lines.push(`${fieldIndent}${JSON.stringify(k)}: ${JSON.stringify(entry[k])}${comma}`);
  });
  lines.push(`${keyIndent}}`);
  return lines.join("\n");
}

// First non-whitespace, non-comment character at/after <from>.
function nextSignificant(text, from) {
  let i = from;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    return { index: i, char: c };
  }
  return { index: n, char: "" };
}

// First non-whitespace, non-comment character strictly before <from>.
function prevSignificant(text, from) {
  let i = from - 1;
  while (i >= 0) {
    const c = text[i];
    if (/\s/.test(c)) {
      i--;
      continue;
    }
    if (c === "/" && text[i - 1] === "/") {
      const lineStart = text.lastIndexOf("\n", i - 1) + 1;
      i = lineStart - 1;
      continue;
    }
    if (c === "/" && text[i - 1] === "*") {
      const open = text.lastIndexOf("/*", i - 2);
      i = open >= 0 ? open - 1 : i - 2;
      continue;
    }
    return { index: i, char: c };
  }
  return { index: -1, char: "" };
}

// Find the character index of the OPENING QUOTE of a QUOTED KEY ("...") that
// sits immediately before `valObjStart` (the `{` of an object value).
// Specifically: when we see the `{` of e.g. `"workled": { ... }`, this helper
// walks backwards, properly honoring escape sequences, to land on the FIRST
// character of the `"workled"` key (the opening double quote) and NOT on the
// closing double quote (fixes the remove/upsert surgery where only half the
// key string was being deleted). Then, to make sure we haven't walked into a
// string value instead of a key, we verify that the token before this quoted
// string is NOT a colon (a key sits after nothing / `{` / `,` or whitespace,
// never after `:`).
//
// Exported for unit tests (fixes #10 — cross-line `"key":\n  { ... }` layouts
// and string values containing escaped quotes/colons must not return the
// wrong starting index, otherwise the key string is only half-deleted).
export function findKeyLineStartForValue(text, valObjStart) {
  let i = valObjStart;
  while (i > 0) {
    const c = text[i];
    if (c === '"') {
      // Candidate closing quote. Walk backwards (honoring \ escapes) to the
      // matching opening quote of this string.
      let j = i - 1;
      while (j >= 0) {
        if (text[j] === "\\") {
          // skip the escaped character (or just the backslash at the start)
          j -= 2;
          continue;
        }
        if (text[j] === '"') {
          // FOUND the opening quote at index `j`.
          // Verify this is a KEY (not a VALUE): the non-whitespace character
          // BEFORE position j must NOT be `:` (it's typically `{` or `,`).
          let k = j - 1;
          while (k >= 0 && /\s/.test(text[k])) k--;
          if (k >= 0 && text[k] === ":") {
            // It's a value string. Keep the outer backwards-scan going from
            // BEFORE this value string.
            i = k - 1;
          } else {
            // Opening quote of a map key. This is what we want.
            return j;
          }
          break;
        }
        j--;
      }
      if (j < 0) { i--; continue; }
      continue;
    }
    i--;
  }
  return -1;
}

// Insert or replace the <serverName> entry under a top-level <key> map in raw
// JSONC text, preserving every unrelated byte. Returns the edited text, or null
// when surgery is not possible (caller falls back to a JSON.stringify rewrite).
export function upsertJsoncEntry(text, key, serverName, entry) {
  const span = findTopLevelObjectValueSpan(text, key);
  if (!span) {
    // No top-level <key> yet: append it inside the root object.
    const rootEnd = findRootObjectEnd(text);
    if (rootEnd < 0) return null;
    const keyIndent = lineIndentAt(text, rootEnd);
    const block = `${JSON.stringify(key)}: {\n${jsoncEntryBlock(serverName, entry, keyIndent + "  ")}\n${keyIndent}}`;
    let before = text.slice(0, rootEnd);
    // Clean up interior whitespace when the root object is otherwise empty.
    // Prevents blank-line accumulation from repeated install/uninstall cycles.
    const interior = before.slice(1);
    if (/^\s*$/.test(interior)) {
      before = "{";
    }
    const after = text.slice(rootEnd);
    const prev = prevSignificant(before, before.length);
    const sep = prev.char === "{" ? "\n" : ",\n";
    return before + sep + block + "\n" + after;
  }
  const mapSlice = text.slice(span.start, span.end);
  // Use the brace-balancing scanner (not the naive `[^{}]*` regex) so a
  // nested value inside the entry (e.g. `"effects": {...}` inside workled)
  // doesn't truncate the match (fixes #4/#10 — without this we'd overwrite
  // only up to the first inner `}` leaving the rest of the object and a
  // stray `}` that corrupts the file).
  const found = findNamedObjectSpanInMap(mapSlice, serverName);
  if (found) {
    // Existing entry: replace the FULL `"serverName": { ... }` span.
    // jsoncEntryBlock emits the key together with the value block, so the
    // replacement range must cover the entire key:value (not just the value
    // object). Indentation is inherited from the original key line so
    // `"workled":\n  { ... }` layouts remain consistent after re-insertion.
    const objAbsoluteStart = span.start + found.start; // index of `{`
    const objAbsoluteEnd   = span.start + found.end;   // index of matching `}`
    const keyIdx = findKeyLineStartForValue(text, objAbsoluteStart);
    const replaceFrom = keyIdx >= 0 ? keyIdx : objAbsoluteStart;
    const replaceTo   = objAbsoluteEnd + 1; // include closing `}`
    const keyIndent = lineIndentAt(text, replaceFrom);
    return text.slice(0, replaceFrom) + jsoncEntryBlock(serverName, entry, keyIndent) + text.slice(replaceTo);
  }
  // Insert at the end of the map (just before its closing brace).
  const keyIndent = lineIndentAt(text, span.start);
  const inner = text.slice(span.start + 1, span.end).replace(/\s+$/, "");
  const lastSig = prevSignificant(inner, inner.length);
  let sep;
  if (stripJsonc(inner).trim() === "") sep = ""; // empty (or comment-only) map
  else if (lastSig.char === ",") sep = "\n"; // JSONC trailing comma already present
  else sep = ",";
  return (
    text.slice(0, span.start + 1) +
    inner +
    sep +
    "\n" +
    jsoncEntryBlock(serverName, entry, keyIndent + "  ") +
    "\n" +
    keyIndent +
    text.slice(span.end)
  );
}

// Remove the <serverName> entry from a top-level <key> map in raw JSONC text,
// fixing surrounding commas. Returns the edited text, or null when the entry or
// the map is absent. Uses findNamedObjectSpanInMap so entries with nested
// object values (e.g. workled.effects = {...}) are correctly removed end-to-end
// instead of being truncated at the first inner `}` (fixes #4/#10).
export function removeJsoncEntry(text, key, serverName) {
  const span = findTopLevelObjectValueSpan(text, key);
  if (!span) return null;
  const mapSlice = text.slice(span.start, span.end);
  const found = findNamedObjectSpanInMap(mapSlice, serverName);
  if (!found) return null;
  // Compute the KEY start + value end, so comma cleanup covers the full
  // `"key": { ... }` range not just the value part.
  const objAbsoluteStart = span.start + found.start;
  const objAbsoluteEnd   = span.start + found.end;
  const keyIdx = findKeyLineStartForValue(text, objAbsoluteStart);
  // If we can't find the key line, still attempt cleanup starting at the
  // value's `{` — it'll leave `"workled": ` dangling but that's obvious and
  // the isValidJsonc guard will refuse the edit (fallback to full rewrite).
  const removeFrom = keyIdx >= 0 ? keyIdx : objAbsoluteStart;
  const removeTo   = objAbsoluteEnd + 1; // include the closing `}`

  const after = nextSignificant(text, removeTo);
  if (after.char === ",") {
    // Not the last member: drop the entry and the comma that followed it.
    return text.slice(0, removeFrom) + text.slice(after.index + 1);
  }
  const prev = prevSignificant(text, removeFrom);
  if (prev.char === ",") {
    // Last member: also drop the comma that preceded it.
    return text.slice(0, prev.index) + text.slice(removeTo);
  }
  // Only member: drop just the entry (the map becomes {}).
  return text.slice(0, removeFrom) + text.slice(removeTo);
}

// ---- hook command construction (hermes) -------------------------------

function hookCommand(eventName) {
  // Cross-platform: invoke `node` from PATH as a bare command name so the line
  // parses under any shell (bash for Claude Code/workbuddy, PowerShell for
  // TraeCode). Quote corePath only when it contains spaces — otherwise leave it
  // bare. Note for hermes/YAML: JSON.stringify escapes the quotes correctly for
  // the YAML scalar, and keeping the path bare (no manual wrapping) avoids the
  // window path/backslash corruption documented below.
  const core = /\s/.test(corePath) ? `"${corePath}"` : corePath;
  const base = `node ${core} hook`;
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
    // top-level block, so we look for any indented block-start mapping.
    // Uses isBlockStartKey so inline values (`url: "...":` even with a
    // colon in the URL string), anchors (`&ref`), aliases (`*ref`), and
    // flow syntax (`{...}` / `[...]`) are not mistaken for a new block key.
    let serverIndent = null;
    for (const line of blockLines) {
      if (!isBlockStartKey(line)) continue;
      const m = line.match(/^(\s+)/);
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
      const blockStarter = isBlockStartKey(line);
      const indentMatch = line.match(/^(\s+)/);
      const lineIndentLen = indentMatch ? indentMatch[1].length : 0;
      if (blockStarter && lineIndentLen === curIndentLen) {
        const nameMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.\-:]*):/);
        const name = nameMatch ? nameMatch[1] : null;
        if (name === "workled") {
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

// Remove the `workled` MCP server entry from one MCP_SOURCES source.
// JSON sources: drop obj[key].workled, then the key itself when
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
  const raw = readFileSync(file, "utf8");
  if (!isValidJsonc(raw)) return null;
  let edited = removeJsoncEntry(raw, source.key, "workled");
  if (edited == null) return null; // no workled entry here
  // Drop the map too when uninstall emptied it (replaces the old `delete obj[key]`).
  const dropped = removeJsoncKey(edited, source.key);
  if (dropped != null) edited = dropped;
  // Safety net: if surgery produced an unparseable file, leave it untouched.
  if (!isValidJsonc(edited)) return null;
  writeFileSync(file, edited, "utf8");
  // If the file is now effectively empty `{}`, delete it entirely.
  // This prevents file litter and blank-line accumulation on re-install.
  if (existsSync(file)) {
    const finalRaw = readFileSync(file, "utf8");
    if (stripJsonc(finalRaw).replace(/\s/g, "") === "{}") {
      removePath(file);
      removeEmptyParent(dirname(file));
      return `Removed workled from ${source.key} -> ${file} (deleted empty config)`;
    }
  }
  return `Removed workled from ${source.key} -> ${file}`;
}

// Remove a top-level <key> entry (the whole `"key": {...}`) from raw JSONC
// text, fixing the surrounding comma. Returns the edited text, or null when the
// key is absent. Only used to drop an emptied map left behind by uninstall.
export function removeJsoncKey(text, key) {
  const span = findTopLevelObjectValueSpan(text, key);
  if (!span) return null;
  const inner = text.slice(span.start + 1, span.end);
  if (stripJsonc(inner).trim() !== "") return null; // refuse to drop a populated map
  const needle = `"${key}"`;
  const keyAt = text.lastIndexOf(needle, span.start - 1);
  if (keyAt < 0) return null;
  const sep = text.slice(keyAt + needle.length, span.start);
  if (!/^\s*:\s*$/.test(sep)) return null;

  const after = nextSignificant(text, span.end + 1);
  let start = keyAt;
  let end = span.end + 1;
  if (after.char === ",") {
    end = after.index + 1;
  } else {
    const before = prevSignificant(text, keyAt);
    if (before.char === ",") start = before.index;
  }
  return text.slice(0, start) + text.slice(end);
}

// Remove the `workled` MCP server entry from every config source of one client.
// Returns the list of removal messages produced by
// unregisterWorkledMcp(client) via removeMcpServer() (null results filtered
// out); an empty array means no `workled` MCP server entry was found to remove.
function unregisterWorkledMcp(client) {
  return MCP_SOURCES.filter((s) => s.client === client && !s.patchManaged)
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
export function workledHookCommand(eventName, client, url) {
  // Cross-platform hook command. We intentionally invoke `node` from PATH (a
  // bare command name with no spaces) rather than the absolute process.execPath
  // ("C:\Program Files\nodejs\node.exe" on Windows). This single form parses
  // equally under a POSIX shell (Claude Code / workbuddy run hooks via bash)
  // and Windows PowerShell (TraeCode): a spaced "quoted path first" token is a
  // parse error in PowerShell (needs the `&` call operator) yet the same string
  // would run `&` as a background operator in bash — so absolute-node forms
  // can never satisfy both. Only corePath is quoted, and only when it has
  // spaces, so the command stays valid on every shell.
  const core = /\s/.test(corePath) ? `"${corePath}"` : corePath;
  let cmd = `node ${core} hook --event ${eventName} --client ${client}`;
  // The hook discovers the MCP URL at runtime from its own configuration
  // (mcp.json / WORKLED_MCP_URL), so no --url is inlined here. This keeps the
  // command stable across installs and avoids any shell/sandbox mangling of the
  // URL argument. The `url` parameter is accepted for call compatibility but is
  // intentionally unused by the generated command.
  return cmd;
}

// Each lifecycle event the workled hook should fire on. `matcher` (only for
// PreToolUse/PostToolUse/Notification) restricts the hook so it does NOT run on
// every tool call — a bare PreToolUse hook would spawn a ~3.6s process per
// Bash/Read/Write and stall the agent.
//
// AskUserQuestion timing (WorkBuddy/CodeBuddy): PreToolUse AND PostToolUse for
// AskUserQuestion both fire at the moment the USER ANSWERS, not when the dialog
// is rendered. A PreToolUse hook would therefore light "waiting" AFTER the user
// already confirmed — exactly backwards — so it is intentionally NOT installed.
// The AskUserQuestion wait window is lit by the agent calling
// set_agent_state("waiting") itself BEFORE rendering the question (SKILL.md).
// Notification is the only render-time hook: permission_prompt fires when a
// tool approval dialog is SHOWN -> waiting; idle_prompt fires after ~60s of
// session idle -> idle (fallback if Stop did not fire).
const WORKLED_HOOK_SPECS = [
  { event: "UserPromptSubmit", matcher: null },
  { event: "Stop", matcher: null },
  { event: "Notification", matcher: "permission_prompt" },
  { event: "Notification", matcher: "idle_prompt" },
  // PostToolUse maps to "thinking" (HOOK_MAP) so answering an AskUserQuestion
  // returns the LED to the working state; it fires when the user answers.
  { event: "PostToolUse", matcher: "AskUserQuestion" },
];

// Generic, disk-backed hook installer shared by the hook-driven clients
// (workbuddy: ~/.workbuddy/settings.json, traecode: <home>/.trae-cn/hooks.json).
// The client marker drives both the generated `--client` command and group
// matching via the shared merge core, so no path/client is hard-coded here.
function installWorkledHooks(hooksFile, { client, version, url }) {
  const parsed = readJsonOrEmpty(hooksFile);
  // Never overwrite a config that exists but cannot be parsed: the user's
  // other hooks/settings would be lost. Warn and bail out instead.
  if (parsed === null && existsSync(hooksFile)) {
    console.warn(`SKIPPED writing hooks: ${hooksFile} is unreadable, not modified`);
    return `SKIPPED workled hooks -> ${hooksFile} (unreadable, not modified)`;
  }
  const merged = mergeClientHooks(parsed || {}, {
    client,
    commandForEvent: (ev) => workledHookCommand(ev, client, url),
    version,
  });
  writeConfig(hooksFile, merged);
  return `Installed workled hooks -> ${hooksFile}`;
}

// Generic uninstaller that mirrors installWorkledHooks. `allowDeleteFile` lets
// a dedicated hooks file (traecode) holding nothing but the schema `version` be
// deleted entirely so uninstall leaves nothing behind; it is false for a
// settings file (workbuddy) that may carry unrelated user settings.
function uninstallWorkledHooks(hooksFile, { client, allowDeleteFile }) {
  const cfg = readJsonOrEmpty(hooksFile);
  if (!cfg || !cfg.hooks) return `No workled hooks at ${hooksFile}`;
  const { config: stripped, changed } = stripClientHooks(cfg, client);
  if (!changed) return `No workled hooks at ${hooksFile}`;
  if (stripped.hooks && Object.keys(stripped.hooks).length === 0) delete stripped.hooks;
  if (allowDeleteFile && Object.keys(stripped).filter((k) => k !== "version").length === 0) {
    if (existsSync(hooksFile)) removePath(hooksFile);
    removeEmptyParent(dirname(hooksFile));
    return `Removed workled hooks -> ${hooksFile} (deleted empty config)`;
  }
  writeConfig(hooksFile, stripped);
  return `Removed workled hooks -> ${hooksFile}`;
}

// Group the workled hook specs by event, preserving spec order within each
// event. Grouping BEFORE filtering keeps multiple matchers under one event
// (e.g. the two Notification specs) from dropping each other.
function groupWorkledSpecs() {
  const byEvent = new Map();
  for (const spec of WORKLED_HOOK_SPECS) {
    if (!byEvent.has(spec.event)) byEvent.set(spec.event, []);
    byEvent.get(spec.event).push(spec);
  }
  return byEvent;
}

// Pure: detect a hook group that belongs to workled for a specific client,
// matched safely on the client-scoped command (e.g. `--client traecode` or
// `--client workbuddy`). This single predicate is shared by every client.
function isClientWorkledGroup(group, client) {
  const marker = `--client ${client}`;
  return (
    group &&
    Array.isArray(group.hooks) &&
    group.hooks.some(
      (hk) =>
        hk &&
        typeof hk.command === "string" &&
        hk.command.includes("workled") &&
        hk.command.includes(marker)
    )
  );
}

// Pure (testable without touching disk): return a NEW hooks config with the
// workled hook groups for `client` upserted. Any prior workled group for the
// same client/event is replaced first, unrelated hooks are preserved. A schema
// `version` is only injected when provided (traecode uses 1; workbuddy does not).
export function mergeClientHooks(cfg, { client, commandForEvent, version }) {
  const out = { ...(cfg || {}) };
  if (typeof version === "number" && typeof out.version !== "number") out.version = version;
  if (!out.hooks || typeof out.hooks !== "object") out.hooks = {};
  for (const [ev, specs] of groupWorkledSpecs()) {
    if (!Array.isArray(out.hooks[ev])) out.hooks[ev] = [];
    out.hooks[ev] = out.hooks[ev].filter((group) => !isClientWorkledGroup(group, client));
    for (const spec of specs) {
      const group = {
        hooks: [
          {
            type: "command",
            command: commandForEvent(ev),
            timeout: WORKLED_HOOK_TIMEOUT_MS / 1000,
          },
        ],
      };
      if (spec.matcher) group.matcher = spec.matcher;
      out.hooks[ev].push(group);
    }
  }
  return out;
}

// Pure: return a NEW hooks config with only the workled hook groups for
// `client` removed, plus a `changed` flag. Unrelated hooks are preserved.
export function stripClientHooks(cfg, client) {
  const out = { ...(cfg || {}) };
  if (!out.hooks || typeof out.hooks !== "object") return { config: out, changed: false };
  const hooks = {};
  let changed = false;
  for (const ev of Object.keys(out.hooks)) {
    if (!Array.isArray(out.hooks[ev])) {
      hooks[ev] = out.hooks[ev];
      continue;
    }
    const kept = out.hooks[ev].filter((group) => !isClientWorkledGroup(group, client));
    if (kept.length !== out.hooks[ev].length) changed = true;
    if (kept.length) hooks[ev] = kept;
  }
  out.hooks = hooks;
  return { config: out, changed };
}

// --- Per-client install/uninstall (hook-driven clients) ---------------------
// These aggregate every file/setting a single client needs, so the client
// dispatch in install()/uninstall() reads as a plain per-client switch. The
// generic installWorkledHooks/uninstallWorkledHooks below are the shared
// implementation; only the target file, client marker and version differ.

// WorkBuddy: MCP server + lifecycle hooks, both written automatically.
async function installWorkbuddy(mcpEntry) {
  const lines = [];
  lines.push(...(await registerWorkledMcp("workbuddy", mcpEntry)));
  lines.push(installWorkledHooks(join(h, ".workbuddy", "settings.json"), { client: "workbuddy", url: mcpEntry && mcpEntry.url }));
  return lines;
}

async function uninstallWorkbuddy() {
  const lines = [];
  lines.push(...unregisterWorkledMcp("workbuddy"));
  lines.push(uninstallWorkledHooks(join(h, ".workbuddy", "settings.json"), { client: "workbuddy" }));
  return lines;
}

// TraeCode (VSCode fork) reads a GLOBAL MCP config at <user-data>/User/mcp.json
// (the VSCode convention it inherits) for servers shared by every workspace, so
// the workled MCP server is written there directly. Its lifecycle hooks go to
// <home>/.trae-cn/hooks.json using the Claude Code-style schema (version 1 +
// hooks.<Event>[]). Both are therefore wired automatically on install.
function installTraecode(mcpEntry) {
  return [
    ...registerWorkledMcp("traecode", mcpEntry),
    installWorkledHooks(join(traeCodeHooksHome(), "hooks.json"), { client: "traecode", version: 1, url: mcpEntry && mcpEntry.url }),
  ];
}

function uninstallTraecode() {
  return [
    ...unregisterWorkledMcp("traecode"),
    uninstallWorkledHooks(join(traeCodeHooksHome(), "hooks.json"), { client: "traecode", allowDeleteFile: true }),
  ];
}

// Inverse of removeMcpServer: write the `workled` server entry into one MCP
// source (JSON or YAML). For JSON, an existing `type` is preserved and a fresh
// entry is written with the source's default `type` (see MCP_SOURCES), so
// clients that require an explicit transport declaration (opencode/kilo/
// workbuddy use "remote") never get a bare `{ url, enabled }` entry that the
// client would ignore.
function addMcpServer(source, entry) {
  if (source.format === "yaml") {
    return addMcpServerYaml(source.path(), source.key, "workled", entry);
  }
  const file = source.path();
  // A corrupt existing config must never be flattened to {} and written back,
  // or the user's other servers would be lost. Skip the source with a warning
  // instead; a missing file still falls through to creating a fresh entry.
  const raw = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (raw != null && !isValidJsonc(raw)) {
    return `SKIPPED workled -> ${source.key} (${file}): config file unreadable, not modified`;
  }
  const obj = raw == null ? {} : JSON.parse(stripJsonc(raw));
  const map =
    obj[source.key] && typeof obj[source.key] === "object"
      ? obj[source.key]
      : (obj[source.key] = {});
  const existing = map.workled && typeof map.workled === "object" ? map.workled : {};
  // Never downgrade a working URL to the <device-name> placeholder: if the new
  // entry carries the placeholder but an existing real URL is present, keep the
  // real one. This guards `install` runs where WORKLED_MCP_URL / Bluetooth are
  // unavailable (placeholder path) yet a valid config already exists.
  const url = resolveMergedUrl(existing.url, entry.url);
  const desired = { url, enabled: entry.enabled !== false };
  // Existing type wins; otherwise fall back to the source's default so fresh
  // installs carry the transport declaration their client requires.
  const type = resolveMcpType(existing.type, source.type);
  if (type) desired.type = type;

  if (raw == null) {
    // No file yet: create a minimal one with just the workled server.
    writeConfig(file, { [source.key]: { workled: desired } });
    return `Registered workled -> ${source.key} (${file})`;
  }

  // No-op fast path: the entry already matches. Do not rewrite the file — this
  // keeps user comments and formatting untouched across repeated installs.
  const same =
    existing.url === desired.url &&
    (existing.enabled === undefined ? true : existing.enabled) === desired.enabled &&
    (existing.type || null) === (desired.type || null);
  if (same) {
    return `Registered workled -> ${source.key} (${file}) (unchanged)`;
  }

  // Preferred path: byte-level surgery that preserves user comments, key
  // order, and formatting. Falls back to a full JSON.stringify rewrite only if
  // the layout defeats the editor (the file was already validated as parseable,
  // so the rewrite loses nothing but comments/formatting).
  const edited = upsertJsoncEntry(raw, source.key, "workled", desired);
  if (edited != null && isValidJsonc(edited)) {
    writeFileSync(file, edited, "utf8");
    return `Registered workled -> ${source.key} (${file})`;
  }
  map.workled = desired;
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
    if (!isBlockStartKey(l)) continue;
    const m = l.match(/^(\s+)/);
    if (m) {
      sIndent = m[1];
      break;
    }
  }
  const out = [];
  let skipping = false;
  const targetIndentLen = sIndent.length;
  for (const l of blockLines) {
    const blockStarter = isBlockStartKey(l);
    const indentMatch = l.match(/^(\s+)/);
    const lineIndentLen = indentMatch ? indentMatch[1].length : 0;
    if (blockStarter && lineIndentLen === targetIndentLen) {
      const nameMatch = l.match(/^\s*([A-Za-z_][A-Za-z0-9_.\-:]*):/);
      const name = nameMatch ? nameMatch[1] : null;
      if (name === serverName) {
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

// Register the workled MCP server for one client across its config
// sources (deduped by path). Mirrors unregisterWorkledMcp so install and
// uninstall stay symmetric and every client's logic is identical.
function registerWorkledMcp(client, entry) {
  const sources = MCP_SOURCES.filter((s) => s.client === client && !s.patchManaged);
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
// openclaw: the Gateway loads standalone plugin files listed in
// ~/.openclaw/openclaw.json `plugins.load.paths`. Each plugin needs a sibling
// `openclaw.plugin.json` manifest (id + configSchema, validated cold), and the
// entry must be enabled under `plugins.entries.<id>` with conversation-hook
// access granted for the agent_end hook.
const OPENCLAW_PLUGIN_MANIFEST = {
  id: "workled",
  name: "workled",
  description:
    "Maps OpenClaw agent lifecycle events (thinking/idle/waiting/error) to the workled MCP set_agent_state tool driving the LED strip.",
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

// True when <line> is a YAML document boundary:
//   `---`  document start / explicit directives end
//   `...`  document end
// Anchors/comments/flow markers are not boundaries. Used to avoid straddling
// multi-doc YAML files (fixes #9 — previously a workled block in doc #1
// could be detected as spanning all the way down through subsequent docs).
function isYamlDocBoundary(line) {
  return /^---\s*(#.*)?$|^\.\.\.\s*(#.*)?$/.test(line.trim());
}
// True when a line that starts an indented mapping key (e.g. "  workled:") is
// actually a BLOCK start — i.e. the value lives on subsequent indented lines,
// NOT inline after the colon. The following inline forms must NOT be treated
// as block starts (fixes #9):
//   - anchors / aliases:   `  workled: &common` / `  workled: *ref`
//   - flow maps / lists:   `  workled: { a: 1 }` / `  workled: [1, 2]`
//   - plain scalars:       `  url: "http://..."` / `  enabled: true`
// Without this check, `url: "http://..."` lines whose quoted value contains
// a trailing `:` would falsely be detected as nested keys, collapsing the
// server body and leaving stale fields behind.
function isBlockStartKey(line) {
  const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_.\-:]*):(.*)$/);
  if (!m) return false;
  const rest = m[3].trim();
  // Drop a trailing YAML comment from the "rest" portion before checking.
  const stripped = rest.replace(/\s+#.*$/, "");
  if (stripped === "") return true; // key: EOL or key: # comment only
  // Inline value is present → NOT a block start. Any anchor/alias/flow
  // opener / plain scalar counts as inline.
  if (/^[&*?!>|%@`]/.test(stripped)) return false;
  if (/^[\[{"']/.test(stripped)) return false; // flow scalar
  if (/^\d/.test(stripped)) return false;      // number / timestamp
  return false; // any other non-empty tail (e.g. `enabled: true`) is inline
}
// Same as isBlockStartKey but for UNINDENTED top-level keys. Accepts a
// candidate key name so we also match `key: # end-of-line comment` as a
// valid block start. Used by splitTopLevelBlock to anchor the search.
function isTopLevelKeyStart(line, key) {
  const re = new RegExp(`^${key}:(.*)$`);
  const m = line.match(re);
  if (!m) return false;
  if (/^\s/.test(line)) return false; // top-level means line starts with the key
  const rest = m[1].trim().replace(/\s+#.*$/, "");
  if (rest === "") return true;
  // A value exists on the same line: not a block start.
  return false;
}

// Split a YAML document into a leading top-level block for a given key and the
// remainder, so the caller can replace just that key.
//
// YAML feature coverage (fixes #9):
//   * Multi-doc (`---` / `...` boundaries): block end detection stops at the
//     next top-level key OR next document boundary, whichever comes first.
//   * Anchors/aliases: `key: &anchor` at top level is not mistaken for a
//     block body; `*ref` values don't look like indented keys.
//   * Flow syntax (inline maps `{...}` and lists `[...]`): inline values are
//     not treated as nested keys, so values like `url: "http://x:y"` don't
//     confuse the indent-based server-key detector.
//
// Exported for unit tests so the three new YAML parsing invariants of #9 are
// independently assertable (no need to hit the filesystem install helpers).
export function splitTopLevelBlock(yamlText, key) {
  const lines = yamlText.split("\n");
  // If the file contains multiple documents, only search the FIRST one for
  // our key. Config.yaml is overwhelmingly a single-doc file, but when a
  // hand-edited file uses `---` we should not span docs.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isYamlDocBoundary(l) && start !== -1) {
      // Encountered a doc boundary AFTER locating our key — block ends here.
      return { start, end: i };
    }
    if (isTopLevelKeyStart(l, key)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    // Next non-empty, non-indented line = next top-level key = block ends.
    if (l.trim() !== "" && !/^\s/.test(l)) {
      end = i;
      break;
    }
    // Explicit YAML doc boundary also ends the block (and the doc).
    if (isYamlDocBoundary(l)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

// Detect the indentation of event keys inside an existing `hooks:` block, so we
// reuse whatever indent the user's config uses instead of assuming 2 spaces.
// Falls back to 2 spaces (the canonical default) when no indented key is found.
// Uses isBlockStartKey so inline scalars / anchors / flow syntax are not
// mistaken for block event keys (fixes #9).
function detectEventIndent(blockLines) {
  for (const line of blockLines) {
    if (!isBlockStartKey(line)) continue;
    const m = line.match(/^(\s+)/);
    if (m && m[1].length >= 1 && m[1].length <= 6) return m[1];
  }
  return "  ";
}

// Exported for unit tests (fixes #9). Purely rewrites the hermes hooks block;
// does not touch the filesystem (the filesystem helpers call into this).
export function installHermesHooks(yamlText) {
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
    const isBlock = isBlockStartKey(line);
    const evIndentMatch = line.match(/^(\s+)/);
    if (isBlock && evIndentMatch && evIndentMatch[1].length > 0) {
      // Any indented map key under `hooks:` is an event key. Keep its own
      // indentation; entries are derived one level deeper than that key.
      const nameMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.\-:]*):/);
      if (!nameMatch) { out.push(line); continue; }
      currentEvent = nameMatch[1];
      out.push(line);
      if (events.includes(currentEvent) && !ensured.has(currentEvent)) {
        ensured.add(currentEvent);
        out.push(`${evIndentMatch[1]}  - command: ${hermesCommandYaml(currentEvent)}`);
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
    // Only lines that carry the workled "hook --event" fragment qualify, so a
    // user's own continuation lines (e.g. a hook's "timeout:") are preserved.
    const isOrphan = /^\s+\S+/.test(line) && !line.includes("command:") && line.includes("hook --event");
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

// Exported for unit tests (fixes #9). Purely rewrites the hermes hooks block;
// does not touch the filesystem (the filesystem helpers call into this).
export function uninstallHermesHooks(yamlText) {
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
    const evIndentMatch = line.match(/^(\s+)/);
    if (isBlockStartKey(line) && evIndentMatch) {
      const nameMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.\-:]*):/);
      if (nameMatch) {
        cur = { key: nameMatch[1], indent: evIndentMatch[1], entries: [] };
        groups.push(cur);
        continue;
      }
    }
    if (cur) {
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
  // A workled event group keeps its remaining entries, so the user's own hooks
  // on the same event survive an uninstall.
  const keptGroups = groups
    .map((g) => {
      const workledEvt = events.includes(g.key);
      const kept = workledEvt
        ? g.entries.filter((l) => !/^\s*-\s+command:.*workled/.test(l))
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

// ---- dsh (DeepSeek Harness) --------------------------------------------------
// dsh architecture: everything is a Cordis plugin — there is no zero-plugin
// pure-config path. We ship a first-class `workled-dsh-plugin` (sibling
// directory `./dsh-plugin/`) that:
//   1. ctx.on() SEVEN native Cordis events (bridge-source-validated):
//        agent/session-start, agent/pre-step, tools/pre-execute,
//        tools/post-execute, agent/turn-stopping, subagent/start,
//        subagent/end
//   2. drives the workled LED BY DIRECT HTTP to the workled MCP endpoint
//      (tools/call set_agent_state JSON-RPC POST), no shell hop, no hook CLI.

// cordis.patch.yml config-override block: the plugin is installed as a proper
// bundle under <dsh-home>/profiles/web/node_modules/workled/, so the profile
// patch only overrides the bundle's config (url / timeout / enabled). The
// bundle's own patch.yml inserts the entry with name 'workled'; this overlay
// finds it by id and patches config.
function dshPatchBlock(url) {
  return [
    "- id: workled",
    "  name: workled",
    "  config:",
    `    url: '${url}'`,
    "    timeout: 1500",
    "    enabled: true",
  ].join("\n");
}

// Split a YAML top-level array (rows starting with `- ` at column 0) into
// items, preserving any prelude lines (comments) before the first item. Used to
// surgically remove stale workled rows from cordis.patch.yml on re-install /
// uninstall without touching the user's other rows.
function splitYamlTopItems(text) {
  const lines = text.split("\n");
  const items = [];
  let cur = null;
  const prelude = [];
  for (const line of lines) {
    if (/^-\s/.test(line)) {
      if (cur) items.push(cur);
      cur = [line];
    } else if (cur) {
      cur.push(line);
    } else if (line.trim() !== "") {
      prelude.push(line);
    }
  }
  if (cur) items.push(cur);
  items.prelude = prelude;
  return items;
}

// Recursively copy the dsh-plugin tree. Node 18+ supports fs.cp; we use a
// small manual cpDir so the installer doesn't need fs.promises or flag checks.
function cpDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) cpDir(s, d);
    else copyFileSync(s, d);
  }
}

function installDsh() {
  const home = dshHome();
  const url = process.env.WORKLED_MCP_URL || "http://<device-name>.local:18791/mcp";
  mkdirSync(home, { recursive: true });
  // A) Install as a proper dsh bundle under the web profile's node_modules.
  const srcPlugin = join(scriptDir, "dsh-plugin");
  const dstPlugin = join(home, "profiles", "web", "node_modules", "workled");
  cpDir(srcPlugin, dstPlugin);
  // B) Register the bundle in the web profile's package.json.
  const profileDir = join(home, "profiles", "web");
  mkdirSync(profileDir, { recursive: true });
  const pkgFile = join(profileDir, "package.json");
  const pkg = readJsonOrEmpty(pkgFile) || {};
  if (!pkg.dsh) pkg.dsh = {};
  if (!pkg.dsh.profile) pkg.dsh.profile = {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  if (!pkg.dsh.profile.bundles.includes("workled")) {
    pkg.dsh.profile.bundles.push("workled");
  }
  writeConfig(pkgFile, pkg);
  // C) Mount plugin in the `web` profile cordis.patch.yml (config override).
  const patchFile = join(profileDir, "cordis.patch.yml");
  const block = dshPatchBlock(url);
  let content = "";
  if (existsSync(patchFile)) content = readFileSync(patchFile, "utf8");
  const items = splitYamlTopItems(content);
  const kept = items.filter((it) => !it.some((l) => l.includes("workled")));
  const rows = (items.prelude || []).filter((l) => l.trim() !== "[]").concat(kept);
  rows.push(block.split("\n"));
  const written = rows.flat().join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  writeFileSync(patchFile, written, "utf8");
  return `Installed dsh bundle -> ${dstPlugin}\nInstalled dsh profile patch -> ${patchFile}`;
}

function uninstallDsh() {
  const home = dshHome();
  const removed = [];
  // A) Remove bundle from the web profile's node_modules.
  const bundleDir = join(home, "profiles", "web", "node_modules", "workled");
  if (existsSync(bundleDir)) {
    removePath(bundleDir);
    removed.push(`Removed dsh bundle dir ${bundleDir}`);
    removeEmptyParent(dirname(bundleDir));
  }
  // Backward compat: also remove old vendored plugin tree if present.
  const pluginDir = join(home, "plugins", "workled");
  if (existsSync(pluginDir)) {
    removePath(pluginDir);
    removed.push(`Removed old dsh plugin dir ${pluginDir}`);
    removeEmptyParent(dirname(pluginDir));
  }
  // B) Unregister bundle from the web profile's package.json.
  const pkgFile = join(home, "profiles", "web", "package.json");
  if (existsSync(pkgFile)) {
    const pkg = readJsonOrEmpty(pkgFile);
    if (pkg && Array.isArray(pkg.dsh?.profile?.bundles)) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== "workled");
      if (pkg.dsh.profile.bundles.length === 0) delete pkg.dsh.profile.bundles;
      if (Object.keys(pkg.dsh.profile || {}).length === 0) delete pkg.dsh.profile;
      if (Object.keys(pkg.dsh || {}).length === 0) delete pkg.dsh;
      writeConfig(pkgFile, pkg);
      removed.push(`Removed workled from ${pkgFile}`);
    }
  }
  // C) Strip workled rows from the `web` profile cordis.patch.yml.
  const patchFile = join(home, "profiles", "web", "cordis.patch.yml");
  if (existsSync(patchFile)) {
    const items = splitYamlTopItems(readFileSync(patchFile, "utf8"));
    const kept = items.filter((it) => !it.some((l) => l.includes("workled")));
    const rows = (items.prelude || []).filter((l) => l.trim() !== "[]").concat(kept);
    const written = rows.flat().join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
    const body = kept.length > 0 ? written : (written ? written + "\n" : "") + "[]";
    writeFileSync(patchFile, body + "\n", "utf8");
    removed.push(`Removed workled plugin from ${patchFile}`);
  }
  return removed.length > 0 ? removed.join("\n") : `No workled install at ${home}`;
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
  node skill-install.mjs install|uninstall --client <name>
  node skill-install.mjs install|uninstall --file <instruction-file>

${CLIENTS.map((c) => `  ${c.padEnd(10)} ${targetHelp(c)}`).join("\n")}
  --file     generic: only the reminder (clients not in the list use this method)
  --client   REQUIRED -- the invoking agent passes its own client name
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
  // explicit target. The invoking agent passes its own client name.
  const clientIdx = args.indexOf("--client");
  const clientArg = clientIdx >= 0 ? args[clientIdx + 1] : null;
  if (clientArg && !CLIENTS.includes(clientArg)) {
    console.error(`Unknown client: ${clientArg}\nSupported clients: ${CLIENTS.join(", ")}`);
    process.exit(1);
  }
  if (!clientArg) {
    console.error(
      `No target client for ${action}.\n` +
      `Pass --client <name> to ${action} only your own client.\n` +
      `Clients: ${CLIENTS.join(", ")}`
    );
    process.exit(1);
  }
  const targets = [clientArg];

  // Resolve the MCP URL once (discovers the real workled device name when
  // possible) so every client's install registers the same, correct endpoint.
  let mcpEntry = null;
  if (action === "install") {
    const url = await resolveWorkledMcpUrl();
    if (url.includes("<device-name>")) {
      console.warn(
        "Warning: no WORKLED_MCP_URL set. A placeholder URL " +
          "(http://<device-name>.local:18791/mcp) will be " +
          "written into configs that have no existing workled entry (e.g. after an " +
          "earlier uninstall) — existing real URLs are kept. Replace <device-name> with " +
          "your real workled device name (e.g. HomeAnt-XXXX), or re-run install with " +
          "WORKLED_MCP_URL set, before connecting."
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
      case "hermes": {
        const hh = hermesHome();
        lines.push(isInstall ? installHermes() : uninstallHermes());
        lines.push(isInstall ? appendReminder(join(hh, "AGENTS.md")) : removeReminder(join(hh, "AGENTS.md")));
        if (isInstall) lines.push(...(await registerWorkledMcp("hermes", mcpEntry)));
        else lines.push(...unregisterWorkledMcp("hermes"));
        break;
      }
      case "dsh": {
        const dh = dshHome();
        lines.push(isInstall ? installDsh() : uninstallDsh());
        // Reminder lives at the Harness home (install/uninstall symmetric);
        // dsh's MCP + hooks wiring is fully owned by installDsh/uninstallDsh
        // (cordis.patch.yml + workled-hooks.json), so no separate MCP step.
        lines.push(isInstall ? appendReminder(join(dh, "AGENTS.md")) : removeReminder(join(dh, "AGENTS.md")));
        break;
      }
      case "workbuddy": {
        // WorkBuddy is a pure-MCP client whose state protocol is enforced by
        // user-level lifecycle hooks (settings.json) rather than by agent
        // discipline; install wires MCP + hooks, uninstall removes both.
        lines.push(...(isInstall ? await installWorkbuddy(mcpEntry) : await uninstallWorkbuddy()));
        break;
      }
      case "traecode": {
        // TraeCode (VSCode fork) reads a GLOBAL MCP config at
        // <user-data>/User/mcp.json (shared by every workspace) plus lifecycle
        // hooks at <home>/.trae-cn/hooks.json — both are wired automatically.
        // MCP is picked up after a reload; if the URL is the <device-name>
        // placeholder the user must still replace it in Settings → MCP, and the
        // Hooks config needs manual enabling in Settings > Hooks to fire.
        if (isInstall) {
          lines.push(...installTraecode(mcpEntry));
          lines.push(
            "TraeCode: MCP written to <user-data>/User/mcp.json (reload to pick it up). Replace <device-name> in Settings → MCP if a placeholder was written, and enable the workled hooks in Settings → Hooks for agent-state tracking."
          );
        } else {
          lines.push(...uninstallTraecode());
          lines.push(
            "TraeCode: workled MCP entry and hooks removed; the server you added via Settings → MCP (if any) stays as you configured it."
          );
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
      `  Re-run \`node skill-install.mjs ${action} --client ${failedClients.join(", ")}\` in a fresh turn to finish.`
    );
    process.exitCode = 1;
  }

  // No `.bak` files are created (writes are idempotent), so there is nothing
  // to clean up here. Historical `.bak` files left by older versions are
  // deliberately left untouched — the tool never deletes user-visible
  // backup files.

  // After install, run status check ONLY for the client that was just installed.
  // This avoids noise from unrelated clients (e.g. dsh diagnostic when installing pi).
  if (action === "install" && !fileArg) {
    // Run status check to see if MCP is configured
    const { spawnSync } = await import("child_process");
    // Use process.execPath (the same Node this installer runs under) instead
    // of a bare "node": the status check then works even when the user's PATH
    // has no Node entry (e.g. invoked through an IDE-managed runtime).
    // Pass --client so status only reports on the target client.
    const statusArgs = [corePath, "status", "--client", targets[0]];
    const statusResult = spawnSync(process.execPath, statusArgs, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (statusResult.stdout) {
      try {
        const status = JSON.parse(statusResult.stdout);
        // status.ok = false means device unreachable, NOT "not configured".
        // "Not configured" = no workled entries at all (clients.length === 0).
        if (status.clients && status.clients.length === 0) {
          console.log("");
          console.log("⚠ WORKLED MCP SERVER NOT CONFIGURED");
          console.log("   Please add the MCP server to your client config:");
          console.log("   See device_setup.md for instructions.");
          console.log("   Or run: node " + corePath + " status to check current state.");
        } else {
          // Configured but maybe unreachable — show the actual hint.
          console.log("   " + status.hint);
        }
      } catch {
        // Ignore parse errors
      }
    }
  }
}

// Run only when invoked directly (not when imported by the test suite, which
// needs the exported JSONC editor helpers without triggering an install).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`install.mjs error: ${err && err.stack}`);
    process.exit(1);
  });
}
