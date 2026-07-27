import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveRuntimeDependency } from "../src/runtime-dependency.js";
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

test("resolves runtime dependencies hoisted beside an installed SceneProof package", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-hoisted-runtime-"));
  const installation = resolve(directory, "node_modules/sceneproof");
  const dependency = resolve(directory, "node_modules/example-runtime");
  const previousHome = process.env.SCENEPROOF_HOME;
  try {
    mkdirSync(installation, { recursive: true });
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      resolve(installation, "package.json"),
      JSON.stringify({ name: "sceneproof" })
    );
    writeFileSync(
      resolve(dependency, "package.json"),
      JSON.stringify({ exports: "./index.js", name: "example-runtime" })
    );
    writeFileSync(resolve(dependency, "index.js"), "export default true;\n");
    process.env.SCENEPROOF_HOME = installation;

    assert.equal(
      resolveRuntimeDependency("example-runtime"),
      resolve(dependency, "index.js")
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.SCENEPROOF_HOME;
    } else {
      process.env.SCENEPROOF_HOME = previousHome;
    }
    rmSync(directory, { force: true, recursive: true });
  }
});
