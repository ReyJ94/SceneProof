import { test } from "bun:test";
import assert from "node:assert/strict";
import { browserGpuArgs } from "../src/browser-gpu.js";

const selectionError = /SCENEPROOF_GPU/;

test("hardware rendering never requests a software adapter", () => {
  for (const backend of ["webgl", "webgpu"] as const) {
    const flags = browserGpuArgs(backend, "hardware", "linux");
    assert.ok(flags.includes("--use-angle=vulkan"));
    assert.ok(!flags.some((flag) => flag.includes("swiftshader")));
  }
});

test("default rendering prefers hardware; software remains explicit", () => {
  assert.deepEqual(
    browserGpuArgs("webgl", undefined, "linux"),
    browserGpuArgs("webgl", "hardware", "linux")
  );
  assert.ok(
    browserGpuArgs("webgl", "software", "linux").includes(
      "--use-angle=swiftshader"
    )
  );
  assert.ok(
    browserGpuArgs("webgpu", "software", "linux").includes(
      "--use-webgpu-adapter=swiftshader"
    )
  );
});

test("invalid adapter selection fails rather than silently choosing software", () => {
  assert.throws(
    () => browserGpuArgs("webgl", "nvidia", "linux"),
    selectionError
  );
});

test("non-Linux hardware is not forced through Linux Vulkan", () => {
  assert.deepEqual(browserGpuArgs("webgpu", "hardware", "darwin"), [
    "--enable-unsafe-webgpu",
  ]);
});
