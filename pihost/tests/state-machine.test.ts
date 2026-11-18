import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertIntentTransition,
  assertTaskTransition,
  normalizeHeartbeat,
  TransitionError,
} from "../src/domains/tasks/state-machine.ts";

test("task transitions mirror WORMHOLE branches", () => {
  assertTaskTransition("created", "running");
  assertTaskTransition("running", "paused");
  assertTaskTransition("paused", "running");
  assertTaskTransition("paused", "timeout"); // 暂停态 deadline 仍生效
  assertTaskTransition("failed", "running"); // rerun
  assertTaskTransition("timeout", "running");
  assert.throws(() => assertTaskTransition("done", "running"), TransitionError);
  assert.throws(() => assertTaskTransition("created", "timeout"), TransitionError);
});

test("intent transitions mirror WORMHOLE branches", () => {
  assertIntentTransition("open", "running");
  assertIntentTransition("running", "open"); // 恢复回退
  assertIntentTransition("running", "blocked");
  assertIntentTransition("failed", "open"); // model_error 重试
  assert.throws(() => assertIntentTransition("stopped", "open"), TransitionError);
  assert.throws(() => assertIntentTransition("open", "done"), TransitionError); // 必须先 running
});

test("normalizeHeartbeat enforces 600s floor (WORMHOLE normalizeHeartbeat)", () => {
  assert.equal(normalizeHeartbeat(100), 600);
  assert.equal(normalizeHeartbeat(undefined), 600);
  assert.equal(normalizeHeartbeat(0), 600);
  assert.equal(normalizeHeartbeat(7200), 7200);
  // db/tasks.go:127-131 has a 600s floor and no upper cap.
  assert.equal(normalizeHeartbeat(1e9), 1e9);
});
