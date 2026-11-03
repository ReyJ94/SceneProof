import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { file, serve } from "bun";
import { defineSession, frameClock } from "../../src/session.js";

const html = new URL("./session-page.html", import.meta.url).pathname;
export default defineSession({
  identity: () => ({ camera: "literal DOM", seed: null }),
  page: {
    async start() {
      const source = await readFile(html);
      const server = serve({
        fetch: () => new Response(file(html)),
        hostname: "127.0.0.1",
        port: 0,
      });
      return {
        dispose() {
          server.stop(true);
        },
        sourcePins: {
          [html]: `sha256:${createHash("sha256").update(source).digest("hex")}`,
        },
        url: server.url.href,
      };
    },
  },
  ready: (session) =>
    session.ready(() => Reflect.get(globalThis, "__pageReady") === true),
  async run(session) {
    await session.click("#replay");
    await session.evidence("gesture.json", await session.invoke("read"));
    await session.frames({
      id: "page-rows",
      rows: [0, 1].map((index) => ({ clock: frameClock(index), index })),
    });
  },
  viewport: { height: 160, scale: 1, width: 240 },
});
