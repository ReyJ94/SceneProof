import { defineReactFixture } from "../../src/react-fixture.js";

let device: GPUDevice;
let canvas: GPUCanvasContext;
let row = 0;
function draw() {
  const encoder = device.createCommandEncoder({ label: "source-encoder" });
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        clearValue: [row / 4, 0.25, 0.5, 1],
        loadOp: "clear",
        storeOp: "store",
        view: canvas.getCurrentTexture().createView(),
      },
    ],
    label: "source-clear",
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
}
export default defineReactFixture({
  actions: {
    draw: () => {
      draw();
    },
    features: () => [...device.features],
  },
  dispose: () => device.destroy(),
  fence: () => device.queue.onSubmittedWorkDone(),
  async ready() {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("native source adapter missing");
    }
    device = await adapter.requestDevice();
    const element = document.querySelector("canvas");
    if (!element) {
      throw new Error("source canvas missing");
    }
    canvas = element.getContext("webgpu") as unknown as GPUCanvasContext;
    canvas.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
    });
    Reflect.set(globalThis, "__SCENEPROOF_SAMPLE_COUNT__", 1);
    draw();
    await device.queue.onSubmittedWorkDone();
  },
  render: () => <canvas height={100} width={160} />,
  seek(frame) {
    row = frame.index;
    draw();
  },
});
