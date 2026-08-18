// dsh install/uninstall round-trip test — 3 cycles, verify each step.
// Run: node test/dsh-roundtrip.mjs
import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dshHome } from "../utils.js";

const SKILL_DIR = join(fileURLToPath(new URL("..", import.meta.url)));
const INSTALLER = join(SKILL_DIR, "skill-install.mjs");
const HOME = dshHome();
const PLUGIN_DIR = join(HOME, "profiles", "web", "node_modules", "workled");
const PATCH_FILE = join(HOME, "profiles", "web", "cordis.patch.yml");
const TEST_URL = "http://192.168.31.146:18791/mcp";

let pass = 0;
let fail = 0;

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  \u2714 ${name}`);
  } else {
    fail++;
    console.log(`  \u2718 ${name} ${detail ? "— " + detail : ""}`);
  }
}

function run(args) {
  return execFileSync(process.execPath, [INSTALLER, ...args], {
    encoding: "utf8",
    env: { ...process.env, WORKLED_MCP_URL: TEST_URL },
  });
}

function patchHasWorkledRow() {
  if (!existsSync(PATCH_FILE)) return false;
  const text = readFileSync(PATCH_FILE, "utf8");
  // The profile patch overrides the bundle's config: id: workled, name: workled.
  return (
    /id:\s*workled\b/.test(text) &&
    /name:\s*workled\b/.test(text)
  );
}

function patchHasUrl() {
  if (!existsSync(PATCH_FILE)) return null;
  const text = readFileSync(PATCH_FILE, "utf8");
  const m = text.match(/url:\s*['"]?(.+?)['"]?\s*$/m);
  return m ? m[1].trim() : null;
}

function pluginFileExists(rel) {
  return existsSync(join(PLUGIN_DIR, rel));
}

function listDir(dir) {
  if (!existsSync(dir)) return "(not exist)";
  try {
    return readdirSync(dir).join(", ") || "(empty)";
  } catch {
    return "(error)";
  }
}

// Save original patch file so we can restore it after the test.
const origPatch = existsSync(PATCH_FILE) ? readFileSync(PATCH_FILE, "utf8") : null;
const origPluginExisted = existsSync(PLUGIN_DIR);

console.log("=== dsh install/uninstall round-trip test (3 cycles) ===");
console.log(`dshHome:    ${HOME}`);
console.log(`pluginDir:  ${PLUGIN_DIR}`);
console.log(`patchFile:  ${PATCH_FILE}`);
console.log(`installer:  ${INSTALLER}`);
console.log("");

// Clean slate: uninstall first to start from zero.
console.log("[pre] cleaning slate...");
try { run(["uninstall", "--client", "dsh"]); } catch {}
console.log("");

for (let cycle = 1; cycle <= 3; cycle++) {
  console.log(`--- Cycle ${cycle} ---`);

  // === INSTALL ===
  console.log("  INSTALL:");
  let installOut;
  try {
    installOut = run(["install", "--client", "dsh"]);
    ok("install command exits cleanly", true);
  } catch (e) {
    installOut = e.stdout || "";
    ok("install command exits cleanly", false, e.message);
  }

  // Check install output mentions plugin + patch
  ok("install output mentions plugin dir", installOut.includes("plugin"), installOut.trim());

  // Check plugin tree
  ok("plugin dir exists", existsSync(PLUGIN_DIR));
  ok("package.json exists", pluginFileExists("package.json"));
  ok("src/index.js exists", pluginFileExists("src/index.js"));
  ok("patch.yml exists", pluginFileExists("patch.yml"));

  // Check patch file
  ok("patch file exists", existsSync(PATCH_FILE));
  ok("patch has workled row (id: workled + name: workled)", patchHasWorkledRow());
  const urlInPatch = patchHasUrl();
  ok("patch has correct URL", urlInPatch === TEST_URL, `got: ${urlInPatch}`);

  // Check patch url uses placeholder format (not workled.local)
  if (existsSync(PATCH_FILE)) {
    const text = readFileSync(PATCH_FILE, "utf8");
    ok("no 'workled.local' in patch", !text.includes("workled.local"), "found workled.local placeholder");
  }

  // === UNINSTALL ===
  console.log("  UNINSTALL:");
  let uninstallOut;
  try {
    uninstallOut = run(["uninstall", "--client", "dsh"]);
    ok("uninstall command exits cleanly", true);
  } catch (e) {
    uninstallOut = e.stdout || "";
    ok("uninstall command exits cleanly", false, e.message);
  }

  ok("uninstall output mentions plugin dir", uninstallOut.includes("plugin"), uninstallOut.trim());

  // Check no leftovers
  ok("plugin dir removed", !existsSync(PLUGIN_DIR), `still exists: ${listDir(PLUGIN_DIR)}`);
  ok("plugins/ dir cleaned up", !existsSync(join(HOME, "plugins")) || readdirSync(join(HOME, "plugins")).length === 0);

  // Check patch file: either doesn't exist, or has no workled row
  if (existsSync(PATCH_FILE)) {
    const text = readFileSync(PATCH_FILE, "utf8");
    ok("patch file has no workled row", !patchHasWorkledRow());
  } else {
    ok("patch file removed (acceptable)", true);
  }

  // Check no leftover bundle dir from the install
  ok("no node_modules/workled dir leftover", !existsSync(PLUGIN_DIR));

  console.log("");
}

// Restore original state
console.log("[post] restoring original state...");
if (origPatch !== null) {
  try {
    const { writeFileSync, mkdirSync } = await import("fs");
    mkdirSync(join(HOME, "profiles", "web"), { recursive: true });
    writeFileSync(PATCH_FILE, origPatch, "utf8");
    console.log("  restored original patch file");
  } catch (e) {
    console.log(`  WARN: could not restore patch file: ${e.message}`);
  }
} else if (existsSync(PATCH_FILE)) {
  // Original had no patch file; remove what we created if it's empty/placeholder
  const text = readFileSync(PATCH_FILE, "utf8").trim();
  if (text === "[]" || text === "") {
    try {
      const { rmSync } = await import("fs");
      rmSync(PATCH_FILE, { force: true });
      console.log("  removed empty patch file (restored to original: no file)");
    } catch {}
  }
}

// Restore plugin directory: the last uninstall cycle removed it, so if the
// original state had the plugin installed, reinstall it now. The bundle is
// registered in package.json + cordis.patch.yml, so uninstall removes the
// node_modules/workled dir.
if (origPluginExisted && !existsSync(PLUGIN_DIR)) {
  try {
    run(["install", "--client", "dsh"]);
    // If origPatch was null (no patch file originally), the install just
    // created one — re-remove the patch file to match the original state.
    // The plugin directory is what matters; the patch row is restored above.
    if (origPatch === null && existsSync(PATCH_FILE)) {
      const text = readFileSync(PATCH_FILE, "utf8").trim();
      if (text === "[]" || text === "") {
        const { rmSync } = await import("fs");
        rmSync(PATCH_FILE, { force: true });
      }
    }
    console.log("  reinstalled plugin directory (was originally installed)");
  } catch (e) {
    console.log(`  WARN: could not reinstall plugin directory: ${e.message}`);
  }
} else if (!origPluginExisted && existsSync(PLUGIN_DIR)) {
  // Original state had no plugin; clean up any leftover
  try {
    run(["uninstall", "--client", "dsh"]);
    console.log("  removed plugin directory (was originally absent)");
  } catch (e) {
    console.log(`  WARN: could not remove plugin directory: ${e.message}`);
  }
}

console.log("");
console.log(`=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
