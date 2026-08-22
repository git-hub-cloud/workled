// Shared utilities for workled skill

import { homedir } from "os";
import { join, dirname, sep } from "path";

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

// Resolve TraeCode's global Hooks config directory. TraeCode is a VSCode fork;
// its global Hooks (Settings > Hooks) live in a `.trae-cn` folder under the
// user's home directory — distinct from the per-edition user-data dir
// (%APPDATA%\Trae CN etc.). Windows uses %userprofile%/.trae-cn/hooks.json;
// macOS/Linux use ~/.trae-cn/hooks.json.
export function traeCodeHooksHome() {
  return join(homedir(), ".trae-cn");
}

// Resolve TraeCode's per-user data dir, where its GLOBAL MCP config lives at
// <dir>/User/mcp.json (the VSCode convention TraeCode inherits). Tools in that
// file are shared by every workspace, mirroring a Settings > MCP "global"
// entry. Windows uses %APPDATA%\Trae CN; macOS/Linux use the platform config
// dir. Note: TraeCode HTTP-type MCP servers are declared bare `{ url,
// enabled }` here — no `type` field.
export function traeCodeUserDir() {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Trae CN");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Trae");
  }
  return join(homedir(), ".config", "trae");
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
