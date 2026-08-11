// Shared utilities for workled skill

import { homedir } from "os";
import { join } from "path";

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