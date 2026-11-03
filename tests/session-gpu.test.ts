import { expect, test } from "bun:test";
import { addGpuSample } from "../src/session-gpu.js";

test("GPU summaries stream raw durations without queue-fence reinterpretation", () => {
  const first = addGpuSample(undefined, 2);
  const second = addGpuSample(first, 8);
  expect(second).toEqual({ count: 2, maximumMs: 8, meanMs: 5, minimumMs: 2 });
  expect(() => addGpuSample(second, -1)).toThrow();
  expect(() => addGpuSample(second, Number.NaN)).toThrow();
});
