import { defineSession, frameClock } from "../../src/session.js";
export default defineSession({
  identity: () => ({ camera: "literal fixture viewport", seed: 12 }),
  async run(session) {
    function* rows() {
      for (let index = 0; index < 3; index += 1) {
        yield { clock: frameClock(index), index };
      }
    }
    await session.frames({
      id: "source-rows",
      restore: (row) => session.invoke("seek", row).then(() => undefined),
      rows: rows(),
    });
    await session.evidence(
      `state-${session.resumed ? "resumed" : "first"}.json`,
      await session.invoke("read")
    );
  },
  source: { entry: new URL("./session-react.tsx", import.meta.url).pathname },
  viewport: { height: 160, scale: 1, width: 240 },
});
