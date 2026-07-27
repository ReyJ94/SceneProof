import { test } from "bun:test";
import assert from "node:assert/strict";

import { retryTransientEsbuildService } from "../src/source-bundle.js";

const MISSING_MODULE_ERROR = /Could not resolve/;

test("retries one transient esbuild IPC service death", async () => {
  let attempts = 0;
  const result = await retryTransientEsbuildService(() => {
    attempts += 1;
    if (attempts === 1) {
      return Promise.reject(
        new Error(
          "The service was stopped: EPERM: operation not permitted, send"
        )
      );
    }
    return Promise.resolve("bundled");
  });

  assert.equal(result, "bundled");
  assert.equal(attempts, 2);
});

test("does not retry deterministic esbuild compilation failures", async () => {
  let attempts = 0;
  await assert.rejects(
    retryTransientEsbuildService(() => {
      attempts += 1;
      return Promise.reject(new Error("Could not resolve ./missing-module"));
    }),
    MISSING_MODULE_ERROR
  );
  assert.equal(attempts, 1);
});
