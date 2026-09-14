import test from "node:test";
import assert from "node:assert/strict";
import { getRemainingSeconds, shouldRefresh } from "../scripts/totp-display.mjs";

test("remaining seconds follows absolute expiry time", () => {
  assert.equal(getRemainingSeconds(30_000, 1_001), 29);
  assert.equal(getRemainingSeconds(30_000, 30_000), 0);
});

test("only the first expiry may trigger one refresh", () => {
  assert.equal(shouldRefresh({ refreshCount: 0, phase: "first" }), true);
  assert.equal(shouldRefresh({ refreshCount: 1, phase: "second" }), false);
});
