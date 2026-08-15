// Shared utilities for workled skill

import { homedir } from "os";
import { join, dirname, sep } from "path";
import { existsSync } from "fs";

// Shared async delay, used by index.js (retry/discovery backoff) and
// skill-install.mjs (openclaw config-stabilisation polling).
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve the hermes home directory (single source of truth, shared by
// index.js and skill-install.mjs):
//   $HERMES_HOME env wins; otherwise Windows uses %LOCALAPPDATA%\hermes,
//   everything else uses ~/.hermes.
export function hermesHome() {
  const env = process.env.HERMES_HOME;
  if (env && env.trim()) return env.trim();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return local && local.trim() ? join(local.trim(), "hermes") : join(homedir(), "AppData", "Local", "hermes");
  }
  return join(homedir(), ".hermes");
}

// Resolve the dsh (DeepSeek Harness) home directory, matching dsh's own
// resolveDshHome() (packages/util/home-paths): $DSH_HOME env wins, otherwise
// `~/.dsh` — cross-platform uniform, even on Windows (dsh never uses %APPDATA%).
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return env.trim();
  return join(homedir(), ".dsh");
}

// Resolve the Trae IDE user-data directory (NOT ~/.cursor — that is Cursor's
// path, a different product). Trae is a VSCode fork; its global MCP config
// lives at <trae-home>/User/globalStorage/mcp.json. $TRAE_HOME env wins;
// otherwise the per-platform user-data dir is used. On Windows the Chinese
// edition ships as "Trae CN" alongside the international "Trae", so the first
// existing directory wins (Trae CN preferred when both are present).
export function traeHome() {
  const env = process.env.TRAE_HOME;
  if (env && env.trim()) return env.trim();
  const dirs = traeCandidateHomes();
  for (const d of dirs) {
    if (existsSync(d)) return d;
  }
  return dirs[0]; // fall back to the international-edition path
}

// Per-platform candidate Trae user-data directories (Trae CN first on Windows
// because the Chinese edition is the common install there).
function traeCandidateHomes() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    const base = appdata && appdata.trim() ? appdata.trim() : join(homedir(), "AppData", "Roaming");
    return [join(base, "Trae CN"), join(base, "Trae")];
  }
  if (process.platform === "darwin") {
    return [join(homedir(), "Library", "Application Support", "Trae")];
  }
  return [join(homedir(), ".config", "Trae")];
}

/**
 * Strip JSONC (JSON with comments) to valid JSON.
 * Handles line and block comments while preserving string literals.
 * A leading UTF-8 BOM is dropped so JSON.parse never trips on it.
 */
export function stripJsonc(src) {
  let out = "";
  let inStr = false;
  let i = 0;
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === ",") {
      // JSONC allows a trailing comma before a closing brace/bracket
      // (`{"a": 1,}`). Drop such a comma. This branch is only reached outside
      // string literals, so a literal `,}` inside a string value is untouched.
      let j = i + 1;
      while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j++;
      if (src[j] === "}" || src[j] === "]") {
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Walk up from `process.cwd()` to find the project root directory.
 * Project root is identified by the presence of a `.git/` directory (or
 * `.trae/mcp.json` / `.gemini/mcp.json` as fallback).  Directories inside
 * a `.agents/skills/` subtree are skipped — skill repos have their own
 * `.git` and prior buggy installs may leave `.trae/mcp.json` artifacts
 * there, both of which would otherwise fool the walker into stopping too
 * early.
 *
 * Returns the first matching ancestor, or `process.cwd()` if no project
 * marker is found.
 */
export function resolveProjectRoot() {
  let dir = process.cwd();
  // `.git` is persistent (never deleted by install/uninstall) and exists
  // at the project root.  `.trae/mcp.json` and `.gemini/mcp.json` are
  // fallbacks for projects that don't use git.
  const markers = [".git", ".trae/mcp.json", ".gemini/mcp.json"];
  for (;;) {
    // Skip directories inside .agents/skills/ — these are agent skill repos,
    // not the project root.
    if (!dir.includes(".agents" + sep + "skills" + sep)) {
      for (const m of markers) {
        if (existsSync(join(dir, m))) return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return process.cwd();
}