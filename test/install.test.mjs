// Unit tests for the JSONC comment-preserving editors (skill-install.mjs) and
// the stripJsonc trailing-comma handling (utils.js).
// Run: node --test test/install.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { stripJsonc } from "../utils.js";
import {
  isValidJsonc,
  upsertJsoncEntry,
  removeJsoncEntry,
  removeJsoncKey,
  findKeyLineStartForValue,
  findNamedObjectSpanInMap,
  splitTopLevelBlock,
  installHermesHooks,
  uninstallHermesHooks,
} from "../skill-install.mjs";

const ENTRY = { url: "http://HomeAnt-A919.local:18791/mcp", enabled: true, type: "remote" };

test("stripJsonc drops comments and trailing commas without touching strings", () => {
  const src = `{
    "a": 1, // line comment
    "b": "x, }", /* block */
    "c": [1, 2,],
  }`;
  assert.deepEqual(JSON.parse(stripJsonc(src)), { a: 1, b: "x, }", c: [1, 2] });
});

test("stripJsonc leaves a lone trailing comma string value intact", () => {
  assert.deepEqual(JSON.parse(stripJsonc('{ "s": ",}" }')), { s: ",}" });
});

test("isValidJsonc accepts comments and trailing commas, rejects broken JSON", () => {
  assert.equal(isValidJsonc('{\n  "a": 1, // trailing\n  "b": [1, 2,],\n}'), true);
  assert.equal(isValidJsonc('{ "a": , }'), false);
});

const COMMENTED = `{
  // user comment that must survive
  "auth": true,
  "mcp": {
    "other": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"] }
  }
}
`;

test("upsertJsoncEntry inserts into an existing map and preserves comments", () => {
  const out = upsertJsoncEntry(COMMENTED, "mcp", "workled", ENTRY);
  assert.ok(out, "expected an edited document");
  assert.ok(out.includes("// user comment that must survive"), "comment preserved");
  assert.ok(out.includes('"other"'), "unrelated server preserved");
  assert.ok(out.includes('"workled"'));
  assert.ok(out.includes('"type": "remote"'));
  const parsed = JSON.parse(stripJsonc(out));
  assert.deepEqual(parsed.mcp.workled, ENTRY);
  assert.equal(parsed.auth, true);
  assert.equal(isValidJsonc(out), true);
});

test("upsertJsoncEntry replaces an existing workled entry in place", () => {
  const withWorkled = `{
  "mcp": {
    "workled": {
      "url": "http://old.local:18791/mcp",
      "enabled": true
    }
  }
}
`;
  const out = upsertJsoncEntry(withWorkled, "mcp", "workled", ENTRY);
  const parsed = JSON.parse(stripJsonc(out));
  assert.deepEqual(parsed.mcp.workled, ENTRY);
  assert.equal(parsed.mcp.workled.url, ENTRY.url);
});

test("upsertJsoncEntry appends a new top-level key when absent", () => {
  const bare = '{ "note": "x" }\n';
  const out = upsertJsoncEntry(bare, "mcp", "workled", ENTRY);
  const parsed = JSON.parse(stripJsonc(out));
  assert.deepEqual(parsed.mcp.workled, ENTRY);
  assert.equal(parsed.note, "x");
  assert.equal(isValidJsonc(out), true);
});

test("upsertJsoncEntry inserts into an empty map without a leading comma", () => {
  const emptyMap = '{\n  "mcp": {}\n}\n';
  const out = upsertJsoncEntry(emptyMap, "mcp", "workled", ENTRY);
  assert.ok(out);
  const parsed = JSON.parse(stripJsonc(out));
  assert.deepEqual(parsed.mcp.workled, ENTRY);
  assert.equal(isValidJsonc(out), true);
});

test("upsertJsoncEntry inserts into a comment-only map", () => {
  const commentOnly = '{\n  "mcp": {\n    // placeholder for future servers\n  }\n}\n';
  const out = upsertJsoncEntry(commentOnly, "mcp", "workled", ENTRY);
  assert.ok(out);
  assert.ok(out.includes("// placeholder for future servers"), "comment preserved");
  const parsed = JSON.parse(stripJsonc(out));
  assert.deepEqual(parsed.mcp.workled, ENTRY);
  assert.equal(isValidJsonc(out), true);
});

test("removeJsoncEntry deletes workled in the middle of a map and fixes commas", () => {
  const middle = `{
  "mcp": {
    "a": 1,
    "workled": { "url": "u", "enabled": true },
    "b": 2
  }
}
`;
  const out = removeJsoncEntry(middle, "mcp", "workled");
  const parsed = JSON.parse(stripJsonc(out));
  assert.equal(parsed.mcp.workled, undefined);
  assert.equal(parsed.mcp.a, 1);
  assert.equal(parsed.mcp.b, 2);
  assert.equal(isValidJsonc(out), true);
});

test("removeJsoncEntry leaves the map when workled is the last member", () => {
  const last = `{
  "mcp": {
    "a": 1,
    "workled": { "url": "u", "enabled": true }
  }
}
`;
  const out = removeJsoncEntry(last, "mcp", "workled");
  const parsed = JSON.parse(stripJsonc(out));
  assert.equal(parsed.mcp.workled, undefined);
  assert.equal(parsed.mcp.a, 1);
  assert.deepEqual(Object.keys(parsed.mcp), ["a"]);
  assert.equal(isValidJsonc(out), true);
});

test("removeJsoncEntry returns null when workled is not present", () => {
  const noWorkled = '{\n  "mcp": { "a": 1 }\n}\n';
  assert.equal(removeJsoncEntry(noWorkled, "mcp", "workled"), null);
});

test("round-trip preserves comments across insert then remove", () => {
  const inserted = upsertJsoncEntry(COMMENTED, "mcp", "workled", ENTRY);
  const removed = removeJsoncEntry(inserted, "mcp", "workled");
  assert.ok(removed);
  assert.ok(removed.includes("// user comment that must survive"));
  const parsed = JSON.parse(stripJsonc(removed));
  assert.equal(parsed.mcp.workled, undefined);
  assert.equal(parsed.mcp.other.command, "npx");
});

test("removeJsoncKey drops an emptied map (last member) with its comma", () => {
  const only = `{
  "auth": true,
  "mcp": {
    "workled": { "url": "u", "enabled": true }
  }
}
`;
  const withoutEntry = removeJsoncEntry(only, "mcp", "workled");
  assert.ok(withoutEntry);
  const out = removeJsoncKey(withoutEntry, "mcp");
  assert.ok(out, "emptied map should be removed");
  assert.equal(out.includes('"mcp"'), false);
  const parsed = JSON.parse(stripJsonc(out));
  assert.equal(parsed.mcp, undefined);
  assert.equal(parsed.auth, true);
  assert.equal(isValidJsonc(out), true);
});

test("removeJsoncKey refuses to drop a populated map", () => {
  const populated = '{\n  "mcp": { "a": 1 }\n}\n';
  assert.equal(removeJsoncKey(populated, "mcp"), null);
});

// --- #5 UTF-8 BOM coverage ----------------------------------------------------
//
// A BOM on the leading byte used to shift every slice index by +1 in
// findTopLevelObjectValueSpan, causing the editor to drop out of surgery mode
// and fall back to a JSON.stringify rewrite (which wipes user comments).
// Lock in the corrected behaviour: both upsert and remove must succeed on a
// BOM-prefixed document, the BOM itself must be preserved in the output, and
// the edited text must remain valid JSONC + parse to the right value.
test("upsertJsoncEntry edits a BOM-prefixed document and keeps the BOM", () => {
  const withBom = "\ufeff" + COMMENTED;
  const out = upsertJsoncEntry(withBom, "mcp", "workled", ENTRY);
  assert.ok(out, "expected edited document, not null");
  assert.equal(out.charCodeAt(0), 0xfeff, "BOM byte must be preserved");
  assert.ok(out.includes("// user comment that must survive"), "comment preserved");
  const parsed = JSON.parse(stripJsonc(out.slice(1))); // strip BOM for JSON.parse
  assert.deepEqual(parsed.mcp.workled, ENTRY);
  assert.equal(isValidJsonc(out.slice(1)), true);
});

test("removeJsoncEntry edits a BOM-prefixed document and keeps the BOM", () => {
  const withWorkled = "\ufeff{\n  \"mcp\": {\n    \"workled\": { \"url\": \"u\" },\n    \"a\": 1\n  }\n}\n";
  const out = removeJsoncEntry(withWorkled, "mcp", "workled");
  assert.ok(out);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.equal(out.includes("workled"), false);
  const parsed = JSON.parse(stripJsonc(out.slice(1)));
  assert.equal(parsed.mcp.workled, undefined);
  assert.equal(parsed.mcp.a, 1);
  assert.equal(isValidJsonc(out.slice(1)), true);
});

// --- #10 cross-line key layouts + key start index ----------------------------
//
// The user can write `"workled":\n  { ... }` with the `{` on a separate line.
// `findKeyLineStartForValue` must walk back from the `{` and return the
// OPENING quote of the key string, not the closing quote — otherwise remove
// surgery leaves half the key behind and the JSON becomes invalid.
test("findKeyLineStartForValue returns opening quote on key+value cross-line layout", () => {
  const text = `{
  "mcp": {
    "workled":
      { "url": "u", "enabled": true }
  }
}`;
  const braceIdx = text.indexOf("{ \"url\"");
  assert.ok(braceIdx > 0);
  const start = findKeyLineStartForValue(text, braceIdx);
  assert.ok(start > 0, `expected opening-quote index, got ${start}`);
  // From the opening-quote index, consume one JSON string and assert it is
  // EXACTLY `"workled"` — if we land on the CLOSING quote instead, we'll only
  // see `"`, which is what the previous buggy implementation produced.
  const rest = text.slice(start);
  const m = rest.match(/^"[^"\\]*(?:\\.[^"\\]*)*"/s);
  assert.ok(m, `expected a full quoted JSON string at start=${start}, saw ${JSON.stringify(rest.slice(0, 20))}`);
  assert.equal(m[0], '"workled"', "the consumed key string must be exactly \"workled\"");
});

test("findKeyLineStartForValue skips values containing escaped quotes/colons", () => {
  // This document has `"value"` (a VALUE string) between the key and the
  // object `{`. If findKeyLineStartForValue honours the colon-prefix check
  // and escape-handling correctly, it returns the `"ke\"y"` opening quote.
  const text = `{
  "weird": { "before": true },
  "ke\\"y": "a:\\"b,c:{[}]d",
  "workled": { "url": "u" }
}`;
  const brace = text.indexOf('{ "url"');
  const start = findKeyLineStartForValue(text, brace);
  assert.ok(start > 0);
  const rest = text.slice(start);
  const m = rest.match(/^"[^"\\]*(?:\\.[^"\\]*)*"/s);
  assert.equal(m && m[0], '"workled"', "must not walk into the preceding value string");
});

test("removeJsoncEntry fully removes a key whose value `{` sits on the next line", () => {
  const crossLine = `{
  "mcp": {
    "a": 1,
    "workled":
      { "url": "u", "enabled": true },
    "b": 2
  }
}
`;
  const out = removeJsoncEntry(crossLine, "mcp", "workled");
  assert.ok(out);
  // After remove, a partial key residue like `"kled"` must NOT appear.
  assert.equal(/workled|kled|workl/.test(out), false, "no partial key residue in:\n" + out);
  const parsed = JSON.parse(stripJsonc(out));
  assert.equal(parsed.mcp.workled, undefined);
  assert.equal(parsed.mcp.a, 1);
  assert.equal(parsed.mcp.b, 2);
  assert.equal(isValidJsonc(out), true);
});

// --- #9 findNamedObjectSpanInMap – nested object / comment / string braces ---
test("findNamedObjectSpanInMap spans through nested objects, comments, and string braces", () => {
  const map = `{
  "other": { "x": 1 },
  "workled": {
    "url": "http://x:1/mcp",
    // a "{" inside a comment is ignored
    "nested": { "a": { "b": "}" }, // trailing brace in a string: "}}}"
      "arr": [1, { "c": 2 }]
    },
    "enabled": true
  },
  "after": true
}`;
  const span = findNamedObjectSpanInMap(map, "workled");
  assert.ok(span, "expected to find workled span");
  const body = map.slice(span.start, span.end + 1);
  // Must start at the `{` immediately after `"workled":` and stop at the
  // matching closing `}` that closes workled's own object.
  assert.ok(body.startsWith("{"));
  assert.ok(body.endsWith("}"));
  const parsed = JSON.parse(stripJsonc(body));
  assert.equal(parsed.url, "http://x:1/mcp");
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.nested.a.b, "}");
  assert.equal(parsed.nested.arr[1].c, 2);
});

// --- #9 splitTopLevelBlock — YAML ---/ flow { } / anchor/alias --------------
test("splitTopLevelBlock stops at a --- document boundary", () => {
  const multiDoc = `# header
hooks:
  tool:before:
    - command: something

---
# Second document — hooks: must not be pulled into the first block
hooks:
  tool:before:
    - command: other
`;
  const s = splitTopLevelBlock(multiDoc, "hooks");
  assert.ok(s);
  const chunk = multiDoc.split("\n").slice(s.start, s.end).join("\n");
  assert.ok(chunk.includes("something"), "first-doc content captured");
  assert.equal(chunk.includes("other"), false, "second doc must not be captured");
});

test("splitTopLevelBlock sees hooks written in flow syntax {...} as non-block", () => {
  const flow = `# A hooks key that is a single inline flow-map => no indented block.
model: "gpt"
hooks: { tool:before: [{ command: "echo hi" }] }
something: else
`;
  // `isBlockStartKey` requires "name:" followed by nothing / a comment (no
  // inline value), so a flow `{ ... }` on the same line should NOT produce
  // a block match → split returns null and installHermesHooks will append
  // a brand-new block-style `hooks:` after.
  const s = splitTopLevelBlock(flow, "hooks");
  assert.equal(s, null, "flow-syntax hooks should not be treated as a block");

  const installed = installHermesHooks(flow);
  assert.ok(installed.includes("\nhooks:"));
  assert.ok(installed.includes("workled"));
  // The original flow-style line should still be there; we do not try to
  // mutate a flow map (we can't do byte-level surgery on inline JSON-in-YAML).
  assert.ok(installed.includes('hooks: { tool:before:'), "original flow line untouched");
});

test("uninstallHermesHooks preserves anchors/aliases and unrelated hooks", () => {
  const yaml = `# hermes-native hook + workled hook, yaml alias
defaults: &defaults
  timeout: 5000
hooks:
  pre_tool_call:
    - <<: *defaults
      name: user-own-hook
      command: echo hello
    - command: npx -y @modelcontextprotocol/workled hook --event pre_tool_call
  post_llm_call:
    - command: npx -y @modelcontextprotocol/workled hook --event post_llm_call
    - command: ls
`;
  const cleaned = uninstallHermesHooks(yaml);
  // The <<:*defaults alias and the user's own `echo hello` and `ls` entries
  // must remain after workled hooks are stripped.
  assert.ok(cleaned.includes("<<: *defaults"), "yaml alias preserved");
  assert.ok(cleaned.includes("echo hello"), "user hook kept");
  assert.ok(cleaned.includes("command: ls"), "user post_llm_call hook kept");
  assert.equal(/hook --event/.test(cleaned), false, "workled hooks removed");
  // Event keys themselves must still be present because they still carry user
  // content (pre_tool_call has echo hello, post_llm_call has ls).
  assert.ok(cleaned.includes("pre_tool_call:"));
  assert.ok(cleaned.includes("post_llm_call:"));
});
