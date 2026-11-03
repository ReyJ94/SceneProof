import { test } from "bun:test";
import assert from "node:assert/strict";
import { launchBrowser } from "../src/browser-runtime.js";

test("the first fixture canvas survives GPU-process initialization", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const samples = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      if (!gl) {
        throw new Error("GPU calibration requires WebGL2");
      }
      const result: Array<{ lost: boolean; pixel: number[] }> = [];
      for (let sample = 0; sample < 3; sample += 1) {
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        result.push({ lost: gl.isContextLost(), pixel: [...pixel] });
        // Deliberately cross the observed first-context loss interval.
        // biome-ignore lint/performance/noAwaitInLoops: Sequential readbacks test one context's survival, not independent work.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return result;
    });
    assert.deepEqual(
      samples,
      Array.from({ length: 3 }, () => ({
        lost: false,
        pixel: [255, 0, 0, 255],
      }))
    );
  } finally {
    await browser.close();
  }
}, 30_000);
