/** Keep the actual native draw before headless presentation discards the swapchain texture. */
export function installNativeCanvasCapture(): void {
  type Surface = {
    canvas: HTMLCanvasElement;
    device: GPUDevice;
    format: GPUTextureFormat;
    current: GPUTexture | null;
    saved: GPUTexture | null;
    width: number;
    height: number;
    generation: number;
    raster: HTMLCanvasElement | null;
    pixels: ImageData | null;
  };
  const surfaces = new Map<GPUCanvasContext, Surface>();
  const hooked = new WeakSet<GPUDevice>();
  let armed = true;
  let generation = 0;
  const overlays: Array<{
    canvas: HTMLCanvasElement;
    image: HTMLCanvasElement;
    opacity: string;
  }> = [];
  function restore() {
    for (const item of overlays.splice(0)) {
      item.canvas.style.opacity = item.opacity;
      item.image.remove();
    }
  }
  const api = {
    arm() {
      if (!armed) {
        generation += 1;
        armed = true;
      }
    },
    dispose() {
      restore();
      for (const surface of surfaces.values()) {
        surface.saved?.destroy();
      }
    },
    pause() {
      armed = false;
    },
    ready() {
      return [...surfaces.values()]
        .filter((surface) => surface.canvas.isConnected)
        .every((surface) => surface.saved && surface.generation === generation);
    },
    restore,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Native readback, exact pixel conversion and reversible DOM staging form one capture transaction.
    async stage() {
      restore();
      const receipts: unknown[] = [];
      for (const surface of surfaces.values()) {
        if (!surface.canvas.isConnected) {
          continue;
        }
        if (
          ![
            "rgba8unorm",
            "rgba8unorm-srgb",
            "bgra8unorm",
            "bgra8unorm-srgb",
          ].includes(surface.format)
        ) {
          throw new Error(
            `Native capture does not support source canvas format ${surface.format}.`
          );
        }
        if (!surface.saved || surface.generation !== generation) {
          throw new Error(
            "Native source draw has not reached the armed capture boundary."
          );
        }
        const { device, saved, width, height } = surface;
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        const buffer = device.createBuffer({
          label: "sceneproof-native-capture-readback",
          size: bytesPerRow * height,
          usage: 0x9,
        });
        try {
          const encoder = device.createCommandEncoder({
            label: "sceneproof-native-capture-readback",
          });
          encoder.copyTextureToBuffer(
            { texture: saved },
            { buffer, bytesPerRow },
            { height, width }
          );
          device.queue.submit([encoder.finish()]);
          // biome-ignore lint/performance/noAwaitInLoops: Stage one native surface at a time to bound readback memory.
          await buffer.mapAsync(0x1);
          const bytes = new Uint8Array(buffer.getMappedRange());
          const raster = surface.raster ?? document.createElement("canvas");
          surface.raster = raster;
          raster.width = width;
          raster.height = height;
          const context = raster.getContext("2d");
          if (!context) {
            throw new Error("Native capture requires a 2D staging context.");
          }
          const pixels =
            surface.pixels?.width === width && surface.pixels.height === height
              ? surface.pixels
              : context.createImageData(width, height);
          surface.pixels = pixels;
          const blueFirst = surface.format.startsWith("bgra");
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              const from = y * bytesPerRow + x * 4,
                to = (y * width + x) * 4;
              pixels.data[to] = bytes[from + (blueFirst ? 2 : 0)] ?? 0;
              pixels.data[to + 1] = bytes[from + 1] ?? 0;
              pixels.data[to + 2] = bytes[from + (blueFirst ? 0 : 2)] ?? 0;
              pixels.data[to + 3] = bytes[from + 3] ?? 0;
            }
          }
          buffer.unmap();
          context.putImageData(pixels, 0, 0);
          const image = raster;
          const styles = getComputedStyle(surface.canvas);
          for (const property of styles) {
            image.style.setProperty(
              property,
              styles.getPropertyValue(property)
            );
          }
          if (styles.position === "static") {
            image.style.position = "absolute";
            image.style.left = `${surface.canvas.offsetLeft}px`;
            image.style.top = `${surface.canvas.offsetTop}px`;
          }
          image.style.pointerEvents = "none";
          const { opacity } = surface.canvas.style;
          surface.canvas.after(image);
          surface.canvas.style.opacity = "0";
          overlays.push({ canvas: surface.canvas, image, opacity });
          receipts.push({
            format: surface.format,
            generation,
            height,
            method: "native-framebuffer-readback",
            source: "actual swapchain draw copied before presentation",
            width,
          });
        } finally {
          buffer.destroy();
        }
      }
      armed = false;
      return receipts;
    },
  };
  Reflect.set(globalThis, "__SCENEPROOF_NATIVE_CAPTURE__", api);
  if (typeof GPUCanvasContext === "undefined") {
    return;
  }
  const { configure } = GPUCanvasContext.prototype;
  GPUCanvasContext.prototype.configure = function (configuration) {
    configure.call(this, {
      ...configuration,
      // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the owner's WebGPU usage flags while adding COPY_SRC.
      usage: (configuration.usage ?? 0x10) | 0x1,
    });
    surfaces.get(this)?.saved?.destroy();
    const canvas = Reflect.get(this, "canvas") as HTMLCanvasElement;
    const surface: Surface = {
      canvas,
      current: null,
      device: configuration.device,
      format: configuration.format,
      generation: -1,
      height: 0,
      pixels: null,
      raster: null,
      saved: null,
      width: 0,
    };
    surfaces.set(this, surface);
    const { device } = configuration;
    if (hooked.has(device)) {
      return;
    }
    hooked.add(device);
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = (commands) => {
      submit(commands);
      if (!armed) {
        return;
      }
      for (const item of surfaces.values()) {
        if (item.device !== device || !item.current) {
          continue;
        }
        const { width, height } = item.canvas;
        if (!item.saved || item.width !== width || item.height !== height) {
          item.saved?.destroy();
          item.saved = device.createTexture({
            format: item.format,
            label: "sceneproof-native-capture-snapshot",
            size: { height, width },
            usage: 0x3,
          });
          item.width = width;
          item.height = height;
        }
        const encoder = device.createCommandEncoder({
          label: "sceneproof-native-capture-snapshot",
        });
        encoder.copyTextureToTexture(
          { texture: item.current },
          { texture: item.saved },
          { height, width }
        );
        submit([encoder.finish()]);
        item.generation = generation;
      }
    };
  };
  const acquire = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    const texture = acquire.call(this),
      surface = surfaces.get(this);
    if (armed && surface) {
      surface.current = texture;
      queueMicrotask(() => {
        if (surface.current === texture) {
          surface.current = null;
        }
      });
    }
    return texture;
  };
}
