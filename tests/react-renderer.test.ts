import { test } from "bun:test";
import assert from "node:assert/strict";

import { resolve } from "node:path";
import { hasRequestedScale, inspectReact } from "../src/react-renderer.js";

const readinessError = /native resource initialization rejected/;

test("waits for fixture-owned resources before publishing rendered structure", async () => {
  const artifact = await inspectReact({
    aliases: {},
    css: [],
    entry: resolve("tests/fixtures/AsyncCanvas.tsx"),
    exportName: "asynchronousCanvas",
    height: 200,
    props: {},
    width: 320,
  });
  assert.ok(JSON.stringify(artifact).includes("resource committed"));
  assert.ok(!JSON.stringify(artifact).includes("resource pending"));
});

test("rejects asynchronous fixture readiness errors instead of capturing a partial frame", async () => {
  await assert.rejects(
    inspectReact({
      aliases: {},
      css: [],
      entry: resolve("tests/fixtures/AsyncCanvas.tsx"),
      exportName: "asynchronousCanvas",
      height: 200,
      props: { fail: true },
      width: 320,
    }),
    readinessError
  );
});

test("accepts Chromium's outward rounding for fractional CSS bounds", () => {
  assert.equal(
    hasRequestedScale(
      { height: 552, width: 2688 },
      { height: 137.297, width: 672 },
      4
    ),
    true
  );
});

test("rejects an image that contains fewer source-rendered pixels", () => {
  assert.equal(
    hasRequestedScale(
      { height: 548, width: 2688 },
      { height: 137.297, width: 672 },
      4
    ),
    false
  );
});

test("rejects dimensions beyond Chromium's one-CSS-pixel rounding window", () => {
  assert.equal(
    hasRequestedScale(
      { height: 556, width: 2688 },
      { height: 137.297, width: 672 },
      4
    ),
    false
  );
});
