import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { resolveRuntimeDependency } from "../src/runtime-dependency.js";
import {
  bundleBrowserDriver,
  retryTransientEsbuildService,
  shouldDiscoverSourceCss,
} from "../src/source-bundle.js";

const MISSING_MODULE_ERROR = /Could not resolve/;
const AMBIGUOUS_OVERLAY_ERROR = /matched 2 locations.*exactly one/i;
const OVERLAY_DIGEST_ERROR = /overlay digest mismatch/i;
const TEXT_RED_500_CLASS = /\.text-red-500/;
const UNUSED_OVERLAY_ERROR = /did not participate.*unused\.ts/i;
test("browser source modules can emit ordinary dependency warnings without Node runtime failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-warning-"));
  try {
    const entry = join(directory, "source.js");
    writeFileSync(entry, "process.emitWarning('source dependency warning');");
    const bundle = await bundleBrowserDriver({
      discoverCss: false,
      entry,
      extraCss: [],
      source: `import ${JSON.stringify(entry)};`,
    });
    const warnings: unknown[] = [];
    runInNewContext(bundle.javascript, {
      console: { warn: (value: unknown) => warnings.push(value) },
    });
    assert.deepEqual(warnings, ["source dependency warning"]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

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

test("does not discover application CSS for a Three-only browser bundle", () => {
  assert.equal(shouldDiscoverSourceCss(false), false);
  assert.equal(shouldDiscoverSourceCss(undefined), true);
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

test("resolves SceneProof's own public React fixture export", () => {
  assert.equal(
    resolveRuntimeDependency("sceneproof/react"),
    resolve(import.meta.dir, "../src/react-fixture.ts")
  );
});

test("bundles a consumer fixture through SceneProof's public React export", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-self-export-"));
  try {
    const entry = resolve(directory, "fixture.tsx");
    writeFileSync(
      entry,
      `import { defineReactFixture } from "sceneproof/react";
       export const fixture = defineReactFixture({ render: () => null });\n`
    );

    const result = await bundleBrowserDriver({
      discoverCss: false,
      entry,
      extraCss: [],
      source: `import { fixture } from ${JSON.stringify(entry)}; globalThis.__fixture = fixture;`,
    });

    assert.ok(
      result.inputs.includes(
        resolve(import.meta.dir, "../src/react-fixture.ts")
      )
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("compiles a consumer Tailwind import from SceneProof's runtime dependencies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-tailwind-runtime-"));
  try {
    const entry = resolve(directory, "entry.ts");
    const stylesheet = resolve(directory, "styles.css");
    writeFileSync(entry, `export const className = "text-red-500";\n`);
    writeFileSync(stylesheet, `@import "tailwindcss";\n`);

    const result = await bundleBrowserDriver({
      discoverCss: false,
      entry,
      extraCss: [stylesheet],
      source: `import { className } from ${JSON.stringify(entry)}; globalThis.__className = className;`,
    });

    assert.match(result.css, TEXT_RED_500_CLASS);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects a source overlay when the expected digest has drifted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-overlay-drift-"));
  try {
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, "export const value = 'original';\n");
    await assert.rejects(
      bundleBrowserDriver({
        discoverCss: false,
        entry,
        extraCss: [],
        source: `import { value } from ${JSON.stringify(entry)}; globalThis.__value = value;`,
        sourceOverlays: [
          {
            expectedDigest: `sha256:${"0".repeat(64)}`,
            file: entry,
            replacements: [{ from: "original", to: "changed" }],
          },
        ],
      }),
      OVERLAY_DIGEST_ERROR
    );
    assert.equal(
      readFileSync(entry, "utf8"),
      "export const value = 'original';\n"
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects ambiguous source overlay replacements instead of rewriting every match", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "sceneproof-overlay-ambiguous-")
  );
  try {
    const entry = resolve(directory, "entry.ts");
    writeFileSync(
      entry,
      "export const first = 'same'; export const second = 'same';\n"
    );
    await assert.rejects(
      bundleBrowserDriver({
        discoverCss: false,
        entry,
        extraCss: [],
        source: `import * as values from ${JSON.stringify(entry)}; globalThis.__value = values;`,
        sourceOverlays: [
          {
            file: entry,
            replacements: [{ from: "same", to: "changed" }],
          },
        ],
      }),
      AMBIGUOUS_OVERLAY_ERROR
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects a source overlay that does not participate in the browser bundle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-overlay-unused-"));
  try {
    const entry = resolve(directory, "entry.ts");
    const unused = resolve(directory, "unused.ts");
    writeFileSync(entry, "export const value = 'entry';\n");
    writeFileSync(unused, "export const value = 'unused';\n");
    await assert.rejects(
      bundleBrowserDriver({
        discoverCss: false,
        entry,
        extraCss: [],
        source: `import { value } from ${JSON.stringify(entry)}; globalThis.__value = value;`,
        sourceOverlays: [
          {
            file: unused,
            replacements: [{ from: "unused", to: "changed" }],
          },
        ],
      }),
      UNUSED_OVERLAY_ERROR
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
