import type { Page } from "playwright-core";

export type ThreeBackend = "webgl" | "webgpu";

export type GraphicsInfo = {
  actual: "webgl" | "webgpu";
  adapter: {
    architecture: string | null;
    available: boolean;
    description: string | null;
    device: string | null;
    isFallbackAdapter: boolean | null;
    vendor: string | null;
  };
  fallback: boolean;
  rasterizer: string | null;
  renderer: "WebGLRenderer" | "WebGPURenderer";
  requested: ThreeBackend;
};

export type BrowserRendererHandle = {
  captureCanvas: () => Promise<HTMLCanvasElement>;
  graphics: GraphicsInfo;
  ownsRenderer: boolean;
  renderScene: (
    scene: import("three").Scene,
    camera: import("three").Camera
  ) => Promise<void>;
  renderer:
    | import("three").WebGLRenderer
    | import("three/webgpu").WebGPURenderer;
};

/**
 * Installs backend policy into a prepared fixture without initializing a GPU
 * renderer. WebGPU initialization and the first render must share the consuming
 * browser task: separating them can invalidate SwiftShader's external objects.
 */
export async function ensureThreeRenderer(
  page: Page,
  requested: ThreeBackend
): Promise<void> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This serialized browser boundary owns backend selection, strict compatibility, initialization, and provenance as one atomic policy.
  await page.evaluate((requestedBackend) => {
    const runtime = Reflect.get(window, "__UISCENE_THREE__") as
      | {
          THREE: typeof import("three");
          WebGPURenderer: typeof import("three/webgpu").WebGPURenderer;
          ensureRenderer?: () => Promise<BrowserRendererHandle>;
          requestedBackend?: ThreeBackend;
          result: {
            renderer?:
              | import("three").WebGLRenderer
              | import("three/webgpu").WebGPURenderer;
            scene: import("three").Scene;
          };
        }
      | undefined;
    if (!runtime) {
      throw new Error("Three.js runtime was not created.");
    }
    if (runtime.ensureRenderer) {
      if (runtime.requestedBackend !== requestedBackend) {
        throw new Error(
          `Prepared Three.js lifecycle already uses ${runtime.requestedBackend}; cannot switch to ${requestedBackend}.`
        );
      }
      return;
    }

    const { THREE, WebGPURenderer, result } = runtime;
    const supplied = result.renderer;
    let suppliedKind: ThreeBackend | null = null;
    if (Reflect.get(supplied ?? {}, "isWebGLRenderer") === true) {
      suppliedKind = "webgl";
    } else if (Reflect.get(supplied ?? {}, "isWebGPURenderer") === true) {
      suppliedKind = "webgpu";
    }
    if (supplied && suppliedKind === null) {
      throw new Error(
        "Fixture renderer is neither a Three.js WebGLRenderer nor WebGPURenderer."
      );
    }
    if (suppliedKind && suppliedKind !== requestedBackend) {
      throw new Error(
        `Fixture returned a ${suppliedKind === "webgl" ? "WebGLRenderer" : "WebGPURenderer"}, but --three-backend ${requestedBackend} was requested. Omit the fixture renderer or return the requested renderer family.`
      );
    }

    if (requestedBackend === "webgpu") {
      const incompatible: string[] = [];
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One traversal classifies all WebGPU-incompatible material paths with attributable owners.
      result.scene.traverse((object) => {
        if (!object.visible) {
          return;
        }
        const rawMaterial = Reflect.get(object, "material") as
          | import("three").Material
          | import("three").Material[]
          | undefined;
        let materials: import("three").Material[] = [];
        if (Array.isArray(rawMaterial)) {
          materials = rawMaterial;
        } else if (rawMaterial) {
          materials = [rawMaterial];
        }
        for (const material of materials) {
          const glslMaterial =
            Reflect.get(material, "isShaderMaterial") === true ||
            Reflect.get(material, "isRawShaderMaterial") === true;
          const customCompile =
            Object.hasOwn(material, "onBeforeCompile") &&
            material.onBeforeCompile !==
              THREE.Material.prototype.onBeforeCompile;
          if (!(glslMaterial || customCompile)) {
            continue;
          }
          const objectId =
            (typeof object.userData.__uisceneRuntimeId === "string" &&
              object.userData.__uisceneRuntimeId) ||
            object.name ||
            object.uuid;
          incompatible.push(
            `${objectId} (${material.type}${customCompile && !glslMaterial ? ", custom onBeforeCompile" : ""})`
          );
        }
      });
      if (incompatible.length > 0) {
        throw new Error(
          `WebGPU compatibility check failed: GLSL-only materials cannot be rendered faithfully by Three.js WebGPURenderer. Migrate them to TSL/NodeMaterial or request --three-backend webgl. Offenders: ${incompatible.join(
            "; "
          )}`
        );
      }
    }

    runtime.requestedBackend = requestedBackend;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Renderer construction and post-init backend provenance must remain one browser-task transaction for WebGPU validity.
    runtime.ensureRenderer = async () => {
      const ownsRenderer = !supplied;
      const requestedAdapter =
        requestedBackend === "webgpu" && !supplied
          ? await navigator.gpu?.requestAdapter({
              powerPreference: "high-performance",
            })
          : null;
      if (requestedBackend === "webgpu" && !supplied && !requestedAdapter) {
        throw new Error(
          "WebGPU was requested, but Chromium did not provide a GPU adapter. Run sceneproof doctor or request --three-backend webgl."
        );
      }
      const requestedDevice = requestedAdapter
        ? await requestedAdapter.requestDevice({
            requiredFeatures: [
              ...requestedAdapter.features,
            ] as GPUFeatureName[],
          })
        : null;
      const renderer =
        supplied ??
        (requestedBackend === "webgpu"
          ? new WebGPURenderer({
              alpha: true,
              antialias: true,
              ...(requestedDevice ? { device: requestedDevice } : {}),
            })
          : new THREE.WebGLRenderer({
              alpha: true,
              antialias: true,
              preserveDrawingBuffer: true,
            }));

      if (!renderer.domElement.isConnected) {
        (document.getElementById("uiscene-root") ?? document.body).append(
          renderer.domElement
        );
      }

      if (Reflect.get(renderer, "isWebGPURenderer") === true) {
        await (renderer as import("three/webgpu").WebGPURenderer).init();
      }

      let graphics: GraphicsInfo;
      if (Reflect.get(renderer, "isWebGPURenderer") === true) {
        const webgpuRenderer =
          renderer as import("three/webgpu").WebGPURenderer;
        const backend = webgpuRenderer.backend as unknown as {
          isWebGPUBackend?: boolean;
        };
        if (backend.isWebGPUBackend !== true) {
          if (ownsRenderer) {
            webgpuRenderer.dispose();
          }
          throw new Error(
            "WebGPU was requested, but Three.js fell back to WebGL2. SceneProof refuses silent backend fallback; run sceneproof doctor and use --three-backend webgl when WebGPU is unavailable."
          );
        }
        const adapter =
          requestedAdapter ??
          (await navigator.gpu?.requestAdapter({
            powerPreference: "high-performance",
          }));
        const text = (value: unknown): string | null =>
          typeof value === "string" && value.length > 0 ? value : null;
        const architecture = text(adapter?.info.architecture);
        const description = text(adapter?.info.description);
        const device = text(adapter?.info.device);
        const vendor = text(adapter?.info.vendor);
        const isFallbackAdapter = adapter
          ? adapter.info.isFallbackAdapter
          : null;
        graphics = {
          actual: "webgpu",
          adapter: {
            architecture,
            available: Boolean(adapter),
            description,
            device,
            isFallbackAdapter,
            vendor,
          },
          fallback: false,
          rasterizer:
            [
              "WebGPU",
              vendor,
              architecture,
              isFallbackAdapter ? "fallback-adapter" : null,
            ]
              .filter(Boolean)
              .join(" ") || "WebGPU",
          renderer: "WebGPURenderer",
          requested: requestedBackend,
        };
      } else {
        const webglRenderer = renderer as import("three").WebGLRenderer;
        const gl = webglRenderer.getContext();
        const extension = gl.getExtension("WEBGL_debug_renderer_info");
        const rawRenderer =
          extension === null
            ? gl.getParameter(gl.RENDERER)
            : gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
        graphics = {
          actual: "webgl",
          adapter: {
            architecture: null,
            available: false,
            description: null,
            device: null,
            isFallbackAdapter: null,
            vendor: null,
          },
          fallback: false,
          rasterizer:
            typeof rawRenderer === "string" ? rawRenderer : String(rawRenderer),
          renderer: "WebGLRenderer",
          requested: requestedBackend,
        };
      }

      return {
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebGPU readback must own padded GPU rows, channel order, resource cleanup, and the WebGL identity path behind one capture contract.
        captureCanvas: async () => {
          if (graphics.actual === "webgl") {
            return renderer.domElement;
          }
          const webgpuRenderer =
            renderer as import("three/webgpu").WebGPURenderer;
          const backend = webgpuRenderer.backend as unknown as {
            context: GPUCanvasContext;
            device: GPUDevice;
          };
          const { height, width } = webgpuRenderer.domElement;
          const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
          const texture = backend.context.getCurrentTexture();
          const readBuffer = backend.device.createBuffer({
            size: bytesPerRow * height,
            usage: 0x08 + 0x01, // COPY_DST + MAP_READ
          });
          const encoder = backend.device.createCommandEncoder();
          encoder.copyTextureToBuffer(
            { texture },
            { buffer: readBuffer, bytesPerRow },
            { height, width }
          );
          backend.device.queue.submit([encoder.finish()]);
          await readBuffer.mapAsync(0x01); // READ
          const mapped = new Uint8Array(readBuffer.getMappedRange());
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) {
            readBuffer.unmap();
            readBuffer.destroy();
            throw new Error(
              "A 2D canvas is required to capture WebGPU evidence."
            );
          }
          const image = context.createImageData(width, height);
          const blueFirst = navigator.gpu
            .getPreferredCanvasFormat()
            .startsWith("bgra");
          for (let y = 0; y < height; y += 1) {
            const sourceRow = y * bytesPerRow;
            const targetRow = y * width * 4;
            for (let x = 0; x < width; x += 1) {
              const source = sourceRow + x * 4;
              const target = targetRow + x * 4;
              image.data[target] = mapped[source + (blueFirst ? 2 : 0)] ?? 0;
              image.data[target + 1] = mapped[source + 1] ?? 0;
              image.data[target + 2] =
                mapped[source + (blueFirst ? 0 : 2)] ?? 0;
              image.data[target + 3] = mapped[source + 3] ?? 0;
            }
          }
          readBuffer.unmap();
          readBuffer.destroy();
          context.putImageData(image, 0, 0);
          return canvas;
        },
        graphics,
        ownsRenderer,
        renderer,
        renderScene: async (scene, camera) => {
          if (graphics.actual === "webgpu") {
            await (
              renderer as import("three/webgpu").WebGPURenderer
            ).compileAsync(scene, camera);
          }
          renderer.render(scene, camera);
        },
      };
    };
  }, requested);
}
