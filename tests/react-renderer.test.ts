import { test } from "bun:test";
import assert from "node:assert/strict";

import { hasRequestedScale } from "../src/react-renderer.js";

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
