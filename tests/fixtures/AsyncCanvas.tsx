import { useCallback } from "react";
import { defineReactFixture } from "../../src/react-fixture.js";

let finish: (() => void) | undefined;
function AsyncCanvas({ fail }: { fail?: boolean }) {
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        return;
      }
      finish = () => {
        element.textContent = fail ? "failed resource" : "resource committed";
      };
    },
    [fail]
  );
  return <div ref={attach}>resource pending</div>;
}
export const asynchronousCanvas = defineReactFixture<{ fail?: boolean }>({
  ready: async ({ fail }) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    finish?.();
    if (fail) {
      throw new Error("native resource initialization rejected");
    }
  },
  render: AsyncCanvas,
});
