import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineSession, runSession } from "../src/session.js";

for (const sourcemap of [undefined, false] as const) {
  test(`defineSession source.sourcemap=${String(sourcemap)} reaches the page bundle`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sceneproof-session-sourcemap-")
    );
    try {
      const init = join(directory, "init.ts");
      await writeFile(init, "globalThis.__sourcemapInit = 42;");
      await runSession(
        defineSession({
          backend: "webgl",
          init: [init],
          async run(session) {
            const observed = await session.page.evaluate(() => ({
              hasMap: [...document.scripts].some((script) =>
                script.textContent?.includes("sourceMappingURL=data:")
              ),
              init: Reflect.get(globalThis, "__sourcemapInit"),
            }));
            expect(observed).toEqual({ hasMap: sourcemap !== false, init: 42 });
            expect(await session.invoke("read")).toEqual({
              committed: false,
              frame: 0,
            });
          },
          source: {
            entry: resolve(import.meta.dir, "fixtures/session-react.tsx"),
            ...(sourcemap === undefined ? {} : { sourcemap }),
          },
          viewport: { height: 160, width: 240 },
        }),
        { out: join(directory, "run") }
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}
