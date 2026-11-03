import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionSourceHtml } from "../src/session.js";
import { bundleBrowserDriver } from "../src/source-bundle.js";

for (const sourcemap of [undefined, "inline", false] as const) {
  test(`session browser bundle sourcemap=${String(sourcemap)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "sceneproof-sourcemap-"));
    try {
      const entry = join(directory, "entry.ts");
      await writeFile(entry, "export const value = 42;");
      await writeFile(join(directory, "style.css"), "body { color: red; }");
      const input = {
        discoverCss: false,
        entry,
        extraCss: [],
        source: `import { value } from ${JSON.stringify(entry)}; import './style.css'; globalThis.answer = value;`,
        ...(sourcemap === undefined ? {} : { sourcemap }),
      };
      const bundle = await bundleBrowserDriver(input);
      for (const output of [bundle.javascript, bundle.css]) {
        expect(output.includes("sourceMappingURL=data:")).toBe(
          sourcemap !== false
        );
      }
      expect(bundle.javascript).toContain("42");
      expect(bundle.css).toContain("color: red");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}

test("session source HTML preserves the existing document and escaping", () => {
  expect(
    sessionSourceHtml({ css: "</style>", inputs: [], javascript: "</script>" })
  ).toBe(
    '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;}#uiscene-root{min-width:1px;min-height:1px;}<\\/style></style><div id="uiscene-root"></div><script><\\/script></script>'
  );
});

test("session source HTML guards base64 pipe size, including UTF-8 bytes, before 100 MB", () => {
  const empty = { css: "", inputs: [], javascript: "" };
  const overhead = Buffer.byteLength(sessionSourceHtml(empty));
  // Exactly 90 MiB after base64 encoding is allowed; just over it is not.
  const htmlByteLimit = (90 * 1024 * 1024 * 3) / 4;
  const javascript = "x".repeat(htmlByteLimit - overhead);
  expect(Buffer.byteLength(sessionSourceHtml({ ...empty, javascript }))).toBe(
    htmlByteLimit
  );
  // Non-ASCII must count as UTF-8, not JS string length.
  const oversized = { ...empty, javascript: `${javascript}é` };
  expect(() => sessionSourceHtml(oversized)).toThrow(
    `${htmlByteLimit + 2} bytes`
  );
  expect(() => sessionSourceHtml(oversized)).toThrow("94371844 bytes");
  expect(() => sessionSourceHtml(oversized)).toThrow(
    "100 MB (100 MiB, 104857600 bytes) pipe message cap"
  );
  expect(() => sessionSourceHtml(oversized)).toThrow(
    "set `source.sourcemap: false`"
  );
});

test("session source HTML guard includes CSS in the pipe payload", () => {
  expect(() =>
    sessionSourceHtml({
      css: "x".repeat(71 * 1024 * 1024),
      inputs: [],
      javascript: "",
    })
  ).toThrow("source.sourcemap: false");
});
