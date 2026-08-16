// Unit tests for the workled plugin's pure helpers.
// Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import {
  getInputTools,
  isInputTool,
  resolveMergedUrl,
  resolveMcpType,
  shouldDedupState,
  drainFlushPromisesForState,
  CLIENTS,
  CLIENT_TARGETS,
} from "../index.js";

const PLACEHOLDER = "http://<device-name>.local:18791/mcp";
const REAL = "http://HomeAnt-A919.local:18791/mcp";

test("getInputTools covers common interactive-tool naming patterns", () => {
  // Coverage for AskUserQuestion / AskUserConfirm / choose_option /
  // select_choice / prompt_input / permission_approval and friends.
  assert.deepEqual(getInputTools(), [
    "question", "confirm", "ask", "choose", "select", "prompt", "input", "approval",
  ]);
});

test("isInputTool matches by substring, case-insensitive", () => {
  assert.equal(isInputTool("AskUserQuestion"), true);
  assert.equal(isInputTool("question"), true);
  assert.equal(isInputTool("ask_question"), true);
  assert.equal(isInputTool("ASKQUESTION"), true);
  assert.equal(isInputTool("get_brightness"), false);
  assert.equal(isInputTool(""), false);
  assert.equal(isInputTool(null), false);
  assert.equal(isInputTool(undefined), false);
  assert.equal(isInputTool(123), false);
});

test("resolveMergedUrl never downgrades a real URL to the placeholder", () => {
  // Existing real URL + incoming placeholder -> keep the real URL.
  assert.equal(resolveMergedUrl(REAL, PLACEHOLDER), REAL);
  // Existing real URL + incoming real URL -> use the incoming one.
  const newer = "http://HomeAnt-B999.local:18791/mcp";
  assert.equal(resolveMergedUrl(REAL, newer), newer);
  // No existing URL + incoming placeholder -> placeholder (first install).
  assert.equal(resolveMergedUrl(undefined, PLACEHOLDER), PLACEHOLDER);
  // Existing placeholder + incoming placeholder -> placeholder.
  assert.equal(resolveMergedUrl(PLACEHOLDER, PLACEHOLDER), PLACEHOLDER);
  // No existing URL + incoming real URL -> real.
  assert.equal(resolveMergedUrl(undefined, REAL), REAL);
});

test("resolveMcpType writes the source default for a fresh entry", () => {
  // No existing type -> source default applies (opencode/kilo/workbuddy).
  assert.equal(resolveMcpType(undefined, "remote"), "remote");
  // Existing type wins over the source default.
  assert.equal(resolveMcpType("http", "remote"), "http");
  assert.equal(resolveMcpType("", "remote"), "remote");
  // No existing type and no default -> null (field omitted entirely).
  assert.equal(resolveMcpType(undefined, undefined), null);
  assert.equal(resolveMcpType(null, ""), null);
});

test("CLIENT_TARGETS covers every client (with default fallback)", () => {
  for (const c of CLIENTS) {
    assert.ok(
      CLIENT_TARGETS[c] !== undefined || CLIENT_TARGETS.default !== undefined,
      `client "${c}" must have a CLIENT_TARGETS entry or a default fallback`
    );
  }
});

// --- #7 shouldDedupState — 200 ms short-window dedup -------------------------
//
// The behaviour we need to lock in: a repeat state is ONLY suppressed if ALL
// of (a) state matches lastSentState, (b) queue is empty (pendingState
// null-ish), (c) last delivery was <200 ms ago. Any other condition lets the
// new state through so the device can reset its animation (the original #7
// bug suppressed ALL same-state transitions, forever).
test("shouldDedupState suppresses a same-state repeat within the 200ms window", () => {
  assert.equal(
    shouldDedupState("thinking", {
      lastSentState: "thinking",
      lastSentStateAtMs: 0,
      nowMs: 199,
      pendingState: null,
    }),
    true
  );
});

test("shouldDedupState lets the same state through AFTER the 200ms window", () => {
  assert.equal(
    shouldDedupState("thinking", {
      lastSentState: "thinking",
      lastSentStateAtMs: 0,
      nowMs: 201, // past 200 ms boundary
      pendingState: null,
    }),
    false,
    "same state must propagate so animation resets on the next turn"
  );
});

test("shouldDedupState lets a different state through even at 0ms delta", () => {
  assert.equal(
    shouldDedupState("idle", {
      lastSentState: "thinking",
      lastSentStateAtMs: 0,
      nowMs: 10,
      pendingState: null,
    }),
    false
  );
});

test("shouldDedupState never dedups while another state is still queued", () => {
  assert.equal(
    shouldDedupState("thinking", {
      lastSentState: "thinking",
      lastSentStateAtMs: 0,
      nowMs: 10,
      pendingState: "waiting", // something still queued → no dedup
    }),
    false,
    "dedup is off while a state is pending; we only collapse fully idle replays"
  );
});

// --- #6 drainFlushPromisesForState – per-state settle ------------------------
//
// Before the #6 fix, a single completed state would settle EVERY queued flush
// regardless of which state each caller was waiting on. Tests below assert
// that (a) entries tagged with a specific state only settle on that exact
// state, (b) state=null "drain" entries settle on EITHER a specific state
// pass OR the special drain state=null pass, and (c) calls with a mismatched
// state leave other entries untouched so they can settle later.
test("drainFlushPromisesForState only settles entries tagged with the matching state", () => {
  const settled = new Map();
  const makeEntry = (name, state) => ({
    state,
    resolve: (r) => settled.set(name, r),
    reject: () => assert.fail(`${name} should not be rejected`),
  });
  const list = [
    makeEntry("idleWaiter", "idle"),
    makeEntry("thinkingWaiter", "thinking"),
  ];

  const nSettled = drainFlushPromisesForState(list, "idle", { state: "idle", sent: true });
  assert.equal(nSettled, 1, "only one waiter should settle on 'idle'");
  assert.equal(list.length, 1, "the thinking waiter must remain queued");
  assert.equal(list[0].state, "thinking");
  assert.ok(settled.has("idleWaiter"));
  assert.equal(settled.get("idleWaiter").state, "idle");

  // Now deliver "thinking": the remaining waiter should settle.
  const nSettled2 = drainFlushPromisesForState(list, "thinking", { state: "thinking", sent: true });
  assert.equal(nSettled2, 1);
  assert.equal(list.length, 0);
  assert.ok(settled.has("thinkingWaiter"));
});

test("drainFlushPromisesForState settles a state=null (drain) waiter on any state + null pass", () => {
  const settled = new Map();
  const makeEntry = (name, state) => ({
    state,
    resolve: (r) => settled.set(name, r),
    reject: () => assert.fail(`${name} should not be rejected`),
  });
  const list = [makeEntry("drainWaiter", null)];

  // A specific state pass also resolves the drain waiter.
  drainFlushPromisesForState(list, "idle", { state: "idle", sent: true });
  assert.equal(list.length, 0);
  assert.ok(settled.has("drainWaiter"));
  assert.equal(settled.get("drainWaiter").state, "idle");

  // A pure queue-drain pass (state=null) also works.
  const list2 = [makeEntry("drainWaiter2", null)];
  drainFlushPromisesForState(list2, null, { state: null, sent: true });
  assert.equal(list2.length, 0);
  assert.ok(settled.has("drainWaiter2"));
});
