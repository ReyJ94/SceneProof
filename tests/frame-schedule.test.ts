import { test } from "bun:test";
import assert from "node:assert/strict";

import { parseFrameSchedule } from "../src/frame-schedule.js";

const END_GREATER = /end.*greater/i;
const STEP_GREATER = /step.*greater/i;
const TOO_MANY_FRAMES = /at most 180/i;

test("continuous frame schedules include a non-divisible end exactly once", () => {
  assert.deepEqual(parseFrameSchedule("0..250@100ms"), {
    frames: [
      { kind: "time", label: "0ms", timeMs: 0 },
      { kind: "time", label: "100ms", timeMs: 100 },
      { kind: "time", label: "200ms", timeMs: 200 },
      { kind: "time", label: "250ms", timeMs: 250 },
    ],
    kind: "continuous",
    stepMs: 100,
  });
});

test("continuous frame schedules reject reversed, zero-step, and excessive ranges", () => {
  assert.throws(() => parseFrameSchedule("100..0@10ms"), END_GREATER);
  assert.throws(() => parseFrameSchedule("0..100@0ms"), STEP_GREATER);
  assert.throws(() => parseFrameSchedule("0..1000@1ms"), TOO_MANY_FRAMES);
});

test("checkpoint frame schedules retain before and settled semantics", () => {
  assert.deepEqual(parseFrameSchedule("before,0,125,settled"), {
    frames: [
      { kind: "before", label: "before", timeMs: null },
      { kind: "time", label: "0ms", timeMs: 0 },
      { kind: "time", label: "125ms", timeMs: 125 },
      { kind: "settled", label: "settled", timeMs: null },
    ],
    kind: "checkpoint",
    stepMs: null,
  });
});
