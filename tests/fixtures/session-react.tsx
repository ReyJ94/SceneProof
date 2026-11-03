import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { defineReactFixture } from "../../src/react-fixture.js";

let frame = 0;
let committed = false;
const listeners = new Set<() => void>();
function Fixture() {
  const index = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => frame,
    () => frame
  );
  return (
    <section
      data-frame={index}
      style={{ background: "#18334d", color: "white", height: 100, width: 160 }}
    >
      React source row {index}
    </section>
  );
}
export default defineReactFixture({
  actions: {
    fail: () => {
      throw new Error("owner rejected action");
    },
    read: () => ({ committed, frame }),
  },
  fence: () => {
    if (!committed) {
      throw new Error("draw not committed");
    }
  },
  render: () => <Fixture />,
  seek: async (sample) => {
    committed = false;
    flushSync(() => {
      frame = sample.index;
      for (const listener of listeners) {
        listener();
      }
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        committed = true;
        resolve();
      })
    );
  },
});
