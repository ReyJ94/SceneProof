import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { launchBrowser, mountBundle } from "./browser-runtime.js";
import {
  type LogicalRegion,
  type RegionRenderReport,
  type RenderReport,
  type SceneArtifact,
  SceneArtifactSchema,
  type ScoutCandidate,
  type ScoutReport,
} from "./scene-schema.js";
import { bundleBrowserDriver } from "./source-bundle.js";

type ThreeOptions = {
  entry: string;
  exportName: string;
  width: number;
  height: number;
  scale?: number;
  isolate?: boolean;
  background?: string;
  out?: string;
  nodeId?: string;
  view?: ThreeTargetView;
  zoom?: number;
  focus?: [number, number, number];
};

export type ThreeTargetView = {
  azimuth: number;
  elevation: number;
  label: string;
};

export type ThreeScoutOptions = {
  background?: string;
  entry: string;
  exportName: string;
  focus?: [number, number, number];
  focusNodeId?: string;
  height: number;
  isolate?: boolean;
  nodeId: string;
  out: string;
  width: number;
};

type ScoutCandidateSpec = {
  id: string;
  sceneCamera: boolean;
  view: ThreeTargetView | null;
  zoom: number;
};

const SCOUT_VIEWS: ThreeTargetView[] = [
  { azimuth: -90, elevation: 18, label: "front" },
  { azimuth: 0, elevation: 18, label: "side" },
  { azimuth: -90, elevation: 89, label: "top" },
  { azimuth: -45, elevation: 35, label: "isometric" },
];

function scoutCandidateSpecs(): ScoutCandidateSpec[] {
  return [
    { id: "original", sceneCamera: true, view: null, zoom: 1 },
    ...SCOUT_VIEWS.flatMap((view) =>
      [1, 4, 8].map((zoom) => ({
        id: `${view.label}-${zoom}x`,
        sceneCamera: false,
        view,
        zoom,
      }))
    ),
  ];
}

function compactNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function detailCommand(input: {
  candidate: ScoutCandidate;
  entry: string;
  exportName: string;
  focus: [number, number, number];
  height: number;
  isolate: boolean;
  nodeId: string;
  width: number;
}): string {
  const focus = input.focus.map(compactNumber).join(",");
  let viewArgument = `--view ${input.candidate.view}`;
  if (input.candidate.view.includes(",")) {
    viewArgument = `--view=${input.candidate.view}`;
  }
  return [
    "sceneproof render",
    shellQuote(input.entry),
    shellQuote(input.nodeId),
    `--export ${shellQuote(input.exportName)}`,
    `--width ${input.width}`,
    `--height ${input.height}`,
    viewArgument,
    `--zoom ${compactNumber(input.candidate.zoom)}`,
    `--look-at ${focus}`,
    "--scale 4",
    ...(input.isolate ? ["--isolate"] : []),
    "--out artifacts/sceneproof-detail.png",
  ].join(" ");
}

function driverSource(input: ThreeOptions): string {
  return `
    import * as THREE from "three";
    import * as SourceModule from ${JSON.stringify(input.entry)};

    (async () => {
      try {
        const factory = SourceModule[${JSON.stringify(input.exportName)}];
        window.__UISCENE_STATUS__ = {
          moduleLoaded: true,
          exportFound: factory !== undefined,
        };
        if (typeof factory !== "function") {
          throw new Error(
            "Requested export ${input.exportName.replaceAll('"', '\\"')} not found or is not a scene factory in ${input.entry.replaceAll('"', '\\"')}"
          );
        }
        const result = await factory({
          width: ${input.width},
          height: ${input.height},
          pixelRatio: ${input.scale ?? 1},
          assets: {},
          time: 0,
        });
        if (!result?.scene?.isScene || !result?.camera?.isCamera) {
          throw new Error("Scene factory must return { scene, camera }.");
        }
        window.__UISCENE_THREE__ = { THREE, result };
        window.__UISCENE_READY__ = true;
      } catch (error) {
        window.__UISCENE_ERROR__ =
          error instanceof Error ? error.message : String(error);
      }
    })();
  `;
}

async function prepareThreePage(options: ThreeOptions) {
  const bundle = await bundleBrowserDriver({
    entry: options.entry,
    extraCss: [],
    source: driverSource(options),
  });
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      viewport: { height: options.height, width: options.width },
    });
    const page = await context.newPage();
    await mountBundle({
      css: "",
      javascript: bundle.javascript,
      page,
    });
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function extractThreeScene(
  page: import("playwright-core").Page,
  options: ThreeOptions
): Promise<SceneArtifact> {
  const artifact = await page.evaluate(
    ({ entry, exportName, width, height }) => {
      const browserRuntime = Reflect.get(window, "__UISCENE_THREE__") as
        | {
            THREE: typeof import("three");
            result: {
              camera: import("three").Camera;
              scene: import("three").Scene;
            };
          }
        | undefined;
      if (!browserRuntime) {
        throw new Error("Three.js runtime was not created.");
      }
      const { THREE, result } = browserRuntime;
      result.scene.updateMatrixWorld(true);

      const objects: import("three").Object3D[] = [];
      result.scene.traverse((object) => objects.push(object));
      const used = new Map<string, number>();
      const ids = new Map<import("three").Object3D, string>();
      const clean = (value: string): string =>
        value
          .normalize("NFKD")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 80);

      for (const object of objects) {
        const semantic =
          (typeof object.userData.sceneproofId === "string" &&
            clean(object.userData.sceneproofId)) ||
          (typeof object.userData.uisceneId === "string" &&
            clean(object.userData.uisceneId)) ||
          (object.name && clean(object.name)) ||
          object.uuid;
        const base = `three:${semantic}`;
        const count = (used.get(base) ?? 0) + 1;
        used.set(base, count);
        const id = count === 1 ? base : `${base}~${count}`;
        ids.set(object, id);
        object.userData.__uisceneRuntimeId = id;
      }

      const vector = (value: { x: number; y: number; z: number }) => [
        value.x,
        value.y,
        value.z,
      ];
      const finiteVector = (value: import("three").Vector3): boolean =>
        [value.x, value.y, value.z].every(Number.isFinite);
      const geometrySnapshot = (object: import("three").Object3D) => {
        const geometry = Reflect.get(object, "geometry") as
          | import("three").BufferGeometry
          | undefined;
        if (!geometry) {
          return;
        }
        const attributes = Object.fromEntries(
          Object.entries(geometry.attributes).map(([name, attribute]) => {
            const values = attribute.array;
            let maximum = Number.NEGATIVE_INFINITY;
            let minimum = Number.POSITIVE_INFINITY;
            let nonFiniteCount = 0;
            for (const value of values) {
              if (typeof value !== "number" || !Number.isFinite(value)) {
                nonFiniteCount += 1;
                continue;
              }
              maximum = Math.max(maximum, value);
              minimum = Math.min(minimum, value);
            }
            return [
              name,
              {
                count: attribute.count,
                itemSize: attribute.itemSize,
                nonFiniteCount,
                normalized: attribute.normalized,
                range:
                  minimum === Number.POSITIVE_INFINITY
                    ? null
                    : { max: maximum, min: minimum },
              },
            ];
          })
        );
        return {
          attributes,
          type: geometry.type,
          vertexCount: geometry.getAttribute("position")?.count ?? 0,
        };
      };
      const primaryMaterial = (object: import("three").Object3D) => {
        const rawMaterial = Reflect.get(object, "material") as
          | import("three").Material
          | import("three").Material[]
          | undefined;
        return Array.isArray(rawMaterial) ? rawMaterial[0] : rawMaterial;
      };
      const objectUniformValue = (value: Record<string, unknown>): unknown => {
        if (
          value.isColor === true &&
          typeof value.getHexString === "function"
        ) {
          return `#${(value.getHexString as () => string)()}`;
        }
        if (typeof value.toArray === "function") {
          const serialized = (value.toArray as () => unknown[])();
          if (
            serialized.every(
              (item) =>
                typeof item === "number" ||
                typeof item === "boolean" ||
                typeof item === "string"
            )
          ) {
            return serialized;
          }
        }
        if (value.isTexture === true) {
          const image = value.image as
            | { height?: unknown; width?: unknown }
            | undefined;
          return {
            colorSpace: value.colorSpace,
            image:
              image &&
              typeof image.width === "number" &&
              typeof image.height === "number"
                ? { height: image.height, width: image.width }
                : undefined,
            name: value.name,
            type: value.type,
            uuid: value.uuid,
          };
        }
        return `[${value.constructor?.name ?? "Object"}]`;
      };
      const uniformValue = (value: unknown): unknown => {
        if (
          value === null ||
          typeof value === "boolean" ||
          typeof value === "number" ||
          typeof value === "string"
        ) {
          return value;
        }
        if (Array.isArray(value)) {
          return value.map(uniformValue);
        }
        if (typeof value !== "object") {
          return String(value);
        }
        return objectUniformValue(value as Record<string, unknown>);
      };
      const materialSnapshot = (object: import("three").Object3D) => {
        const material = primaryMaterial(object);
        if (!material) {
          return;
        }
        const snapshot: Record<string, unknown> = {
          alphaTest: material.alphaTest,
          blending: material.blending,
          depthTest: material.depthTest,
          depthWrite: material.depthWrite,
          opacity: material.opacity,
          side: material.side,
          transparent: material.transparent,
          type: material.type,
          visible: material.visible,
        };
        const color = Reflect.get(material, "color") as
          | import("three").Color
          | undefined;
        if (color) {
          snapshot.color = `#${color.getHexString()}`;
        }
        const metalness = Reflect.get(material, "metalness");
        if (typeof metalness === "number") {
          snapshot.metalness = metalness;
        }
        const roughness = Reflect.get(material, "roughness");
        if (typeof roughness === "number") {
          snapshot.roughness = roughness;
        }
        const rawDefines = Reflect.get(material, "defines") as
          | Record<string, boolean | number | string>
          | undefined;
        if (rawDefines) {
          snapshot.defines = { ...rawDefines };
        }
        const rawUniforms = Reflect.get(material, "uniforms") as
          | Record<string, { value?: unknown }>
          | undefined;
        if (rawUniforms) {
          snapshot.uniforms = Object.fromEntries(
            Object.entries(rawUniforms).map(([name, uniform]) => [
              name,
              uniformValue(uniform.value),
            ])
          );
        }
        return snapshot;
      };
      const boundsSnapshot = (object: import("three").Object3D) => {
        const box = new THREE.Box3().setFromObject(object);
        if (!(finiteVector(box.min) && finiteVector(box.max))) {
          return;
        }
        return {
          worldBox: {
            max: vector(box.max),
            min: vector(box.min),
          },
        };
      };
      const serializeObject = (object: import("three").Object3D) => {
        const id = ids.get(object);
        if (!id) {
          throw new Error("Three.js identity assignment failed.");
        }
        const node: Record<string, unknown> & {
          children: string[];
          id: string;
        } = {
          children: object.children
            .map((child) => ids.get(child))
            .filter((child): child is string => Boolean(child)),
          id,
          kind: object.type,
          name: object.name || undefined,
          parent: object.parent ? (ids.get(object.parent) ?? null) : null,
          source: { export: exportName, file: entry },
          transform: {
            position: vector(object.position),
            rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
            scale: vector(object.scale),
          },
          uuid: object.uuid,
          visible: object.visible,
        };
        const bounds = boundsSnapshot(object);
        if (bounds) {
          node.bounds = bounds;
        }
        const geometry = geometrySnapshot(object);
        if (geometry) {
          node.geometry = geometry;
        }
        const material = materialSnapshot(object);
        if (material) {
          node.material = material;
        }
        return node;
      };
      const nodes = objects.map(serializeObject);
      const warnings = nodes.flatMap((node) => {
        const geometry = Reflect.get(node, "geometry") as
          | {
              attributes?: Record<
                string,
                { range?: { max: number; min: number } | null }
              >;
            }
          | undefined;
        const opacityAttribute = Reflect.get(
          geometry?.attributes ?? {},
          "aOpacity"
        ) as { range?: { max: number; min: number } | null } | undefined;
        const maximumOpacity = opacityAttribute?.range?.max;
        if (typeof maximumOpacity === "number" && maximumOpacity <= 0) {
          return [
            `${node.id} is potentially invisible: geometry attribute aOpacity maximum is 0.`,
          ];
        }
        return [];
      });
      const rootId = ids.get(result.scene);
      if (!rootId) {
        throw new Error("Three.js scene identity is missing.");
      }
      return {
        assets: [],
        entry,
        export: exportName,
        nodes,
        relationships: nodes.flatMap((node) =>
          node.children.map((child) => ({
            from: node.id,
            kind: "parent-child" as const,
            to: child,
          }))
        ),
        root: rootId,
        rootIds: [rootId],
        version: 1 as const,
        viewport: { height, width },
        warnings,
      };
    },
    {
      entry: options.entry,
      exportName: options.exportName,
      height: options.height,
      width: options.width,
    }
  );
  return SceneArtifactSchema.parse(artifact);
}

async function disposeThree(
  page: import("playwright-core").Page
): Promise<void> {
  await page.evaluate(async () => {
    const runtime = Reflect.get(window, "__UISCENE_THREE__") as
      | { result?: { dispose?: () => void | Promise<void> } }
      | undefined;
    await runtime?.result?.dispose?.();
  });
}

export async function inspectThree(
  options: ThreeOptions
): Promise<SceneArtifact> {
  const runtime = await prepareThreePage(options);
  try {
    const artifact = await extractThreeScene(runtime.page, options);
    await disposeThree(runtime.page);
    return artifact;
  } finally {
    await runtime.browser.close();
  }
}

export async function renderThree(
  options: Required<
    Pick<
      ThreeOptions,
      "entry" | "exportName" | "width" | "height" | "scale" | "out" | "nodeId"
    >
  > &
    Pick<ThreeOptions, "isolate" | "background" | "view" | "zoom" | "focus">
): Promise<RenderReport> {
  const totalStartedAt = performance.now();
  const runtime = await prepareThreePage(options);
  const output = resolve(options.out);
  try {
    const scene = await extractThreeScene(runtime.page, options);
    const targetNode = scene.nodes.find((node) => node.id === options.nodeId);
    if (!targetNode) {
      throw new Error(`Target node not found: ${options.nodeId}`);
    }

    await mkdir(dirname(output), { recursive: true });
    const rendered = await runtime.page.evaluate(
      ({
        nodeId,
        width,
        height,
        scale,
        isolate,
        background,
        view,
        zoom,
        focus,
      }) => {
        const renderStartedAt = performance.now();
        const browserRuntime = Reflect.get(window, "__UISCENE_THREE__") as {
          THREE: typeof import("three");
          result: {
            camera: import("three").Camera;
            dispose?: () => void | Promise<void>;
            renderer?: import("three").WebGLRenderer;
            scene: import("three").Scene;
          };
        };
        const { THREE, result } = browserRuntime;
        let target: import("three").Object3D | null = null;
        result.scene.traverse((object) => {
          if (object.userData.__uisceneRuntimeId === nodeId) {
            target = object;
          }
        });
        const selectedTarget = target as import("three").Object3D | null;
        if (!selectedTarget) {
          throw new Error(`Target node not found: ${nodeId}`);
        }

        result.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(selectedTarget);
        const size = box.getSize(new THREE.Vector3());
        const boundsValid =
          [size.x, size.y, size.z].every(Number.isFinite) &&
          Math.max(size.x, size.y, size.z) > 0;
        if (!boundsValid) {
          throw new Error(`Target node has empty bounds: ${nodeId}`);
        }

        const isolateTarget = (
          sceneRoot: import("three").Scene,
          isolatedTarget: import("three").Object3D
        ): void => {
          const contains = (
            ancestor: import("three").Object3D,
            object: import("three").Object3D
          ): boolean => {
            let current: import("three").Object3D | null = object;
            while (current) {
              if (current === ancestor) {
                return true;
              }
              current = current.parent;
            }
            return false;
          };
          sceneRoot.traverse((object) => {
            if (object === sceneRoot) {
              return;
            }
            object.visible =
              Reflect.get(object, "isLight") === true ||
              contains(object, isolatedTarget) ||
              contains(isolatedTarget, object);
          });
        };
        if (isolate) {
          isolateTarget(result.scene, selectedTarget);
        }

        const frameCamera = (framedCamera: import("three").Camera): void => {
          const center = focus
            ? new THREE.Vector3(...focus)
            : box.getCenter(new THREE.Vector3());
          const radius = Math.max(
            box.getBoundingSphere(new THREE.Sphere()).radius,
            0.1
          );
          if (Reflect.get(framedCamera, "isPerspectiveCamera")) {
            const perspective =
              framedCamera as import("three").PerspectiveCamera;
            perspective.aspect = width / height;
            const direction = view
              ? new THREE.Vector3(
                  Math.cos(THREE.MathUtils.degToRad(view.elevation)) *
                    Math.cos(THREE.MathUtils.degToRad(view.azimuth)),
                  Math.cos(THREE.MathUtils.degToRad(view.elevation)) *
                    Math.sin(THREE.MathUtils.degToRad(view.azimuth)),
                  Math.sin(THREE.MathUtils.degToRad(view.elevation))
                )
              : perspective.position.clone().sub(center);
            if (direction.lengthSq() === 0) {
              direction.set(1, -1, 1);
            }
            direction.normalize();
            const halfFov = THREE.MathUtils.degToRad(perspective.fov / 2);
            const distance =
              ((radius / Math.sin(halfFov)) * 1.25) / Math.max(zoom, 0.001);
            perspective.position
              .copy(center)
              .addScaledVector(direction, distance);
            perspective.near = Math.max(0.01, distance - radius * 4);
            perspective.far = Math.max(
              perspective.near + 1,
              distance + radius * 8
            );
            perspective.lookAt(center);
            perspective.updateProjectionMatrix();
            return;
          }
          if (Reflect.get(framedCamera, "isOrthographicCamera")) {
            const orthographic =
              framedCamera as import("three").OrthographicCamera;
            const extent = radius * 1.4;
            orthographic.left = -extent * (width / height);
            orthographic.right = extent * (width / height);
            orthographic.top = extent;
            orthographic.bottom = -extent;
            orthographic.lookAt(center);
            orthographic.updateProjectionMatrix();
          }
        };
        const camera = result.camera.clone();
        frameCamera(camera);
        camera.updateMatrixWorld(true);

        const ownRenderer = !result.renderer;
        const renderer =
          result.renderer ??
          new THREE.WebGLRenderer({
            alpha: background === "transparent",
            antialias: true,
            preserveDrawingBuffer: true,
          });
        const renderedWidth = Math.round(width * scale);
        const renderedHeight = Math.round(height * scale);
        renderer.setPixelRatio(1);
        renderer.setSize(renderedWidth, renderedHeight, false);
        if (background && background !== "transparent") {
          renderer.setClearColor(background, 1);
        } else if (background === "transparent") {
          renderer.setClearColor(0x00_00_00, 0);
        }
        renderer.render(result.scene, camera);
        const canvas = renderer.domElement;
        canvas.dataset.uisceneOutput = "true";
        canvas.style.display = "block";
        canvas.style.height = `${renderedHeight}px`;
        canvas.style.width = `${renderedWidth}px`;
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        document.body.style.margin = "0";
        document.body.replaceChildren(canvas);
        Reflect.set(window, "__UISCENE_OUTPUT_RENDERER__", {
          ownRenderer,
          renderer,
        });
        const center = focus
          ? new THREE.Vector3(...focus)
          : box.getCenter(new THREE.Vector3());

        return {
          boundsValid,
          camera: {
            ...(view
              ? {
                  azimuth: view.azimuth,
                  elevation: view.elevation,
                }
              : {}),
            position: camera.position.toArray(),
            target: center.toArray(),
            view: view?.label ?? "original",
            zoom,
          },
          logicalSize: { height, width },
          renderedSize: {
            height: renderedHeight,
            width: renderedWidth,
          },
          renderMs: performance.now() - renderStartedAt,
        };
      },
      {
        background: options.background ?? null,
        focus: options.focus ?? null,
        height: options.height,
        isolate: options.isolate ?? false,
        nodeId: options.nodeId,
        scale: options.scale,
        view: options.view ?? null,
        width: options.width,
        zoom: options.zoom ?? 1,
      }
    );

    const captureStartedAt = performance.now();
    await runtime.page
      .locator("canvas[data-uiscene-output='true']")
      .screenshot({
        animations: "disabled",
        caret: "hide",
        path: output,
        scale: "css",
        timeout: 120_000,
      });
    const captureMs = performance.now() - captureStartedAt;
    const outputNonempty = (await stat(output)).size > 0;
    const requestedScaleAchieved =
      rendered.renderedSize.width ===
        Math.round(options.width * options.scale) &&
      rendered.renderedSize.height ===
        Math.round(options.height * options.scale);
    const checks = {
      boundsValid: rendered.boundsValid,
      exportFound: true,
      moduleLoaded: true,
      outputNonempty,
      requestedScaleAchieved,
      targetFound: true,
    };
    await runtime.page.evaluate(() => {
      const outputRuntime = Reflect.get(
        window,
        "__UISCENE_OUTPUT_RENDERER__"
      ) as
        | {
            ownRenderer: boolean;
            renderer: import("three").WebGLRenderer;
          }
        | undefined;
      if (outputRuntime?.ownRenderer) {
        outputRuntime.renderer.dispose();
      }
      Reflect.deleteProperty(window, "__UISCENE_OUTPUT_RENDERER__");
    });
    await disposeThree(runtime.page);
    return {
      artifact: output,
      camera: {
        ...rendered.camera,
        position: rendered.camera.position as [number, number, number],
        target: rendered.camera.target as [number, number, number],
      },
      checks,
      logicalSize: rendered.logicalSize,
      nodeId: options.nodeId,
      renderedSize: rendered.renderedSize,
      scale: options.scale,
      success: Object.values(checks).every(Boolean),
      timingsMs: {
        capture: captureMs,
        render: rendered.renderMs,
        total: performance.now() - totalStartedAt,
      },
    };
  } finally {
    await runtime.browser.close();
  }
}

export async function renderThreeRegion(
  options: Required<
    Pick<
      ThreeOptions,
      "entry" | "exportName" | "width" | "height" | "scale" | "out"
    >
  > & {
    region: LogicalRegion;
    background?: string;
  }
): Promise<RegionRenderReport> {
  const totalStartedAt = performance.now();
  const runtime = await prepareThreePage(options);
  const output = resolve(options.out);
  try {
    await mkdir(dirname(output), { recursive: true });
    const rendered = await runtime.page.evaluate(
      ({ width, height, scale, region, background }) => {
        const renderStartedAt = performance.now();
        const browserRuntime = Reflect.get(window, "__UISCENE_THREE__") as {
          THREE: typeof import("three");
          result: {
            camera: import("three").Camera;
            renderer?: import("three").WebGLRenderer;
            scene: import("three").Scene;
          };
        };
        const { THREE, result } = browserRuntime;
        result.scene.updateMatrixWorld(true);
        const camera = result.camera.clone();
        const setViewOffset = Reflect.get(camera, "setViewOffset") as
          | ((
              fullWidth: number,
              fullHeight: number,
              offsetX: number,
              offsetY: number,
              viewWidth: number,
              viewHeight: number
            ) => void)
          | undefined;
        const updateProjectionMatrix = Reflect.get(
          camera,
          "updateProjectionMatrix"
        ) as (() => void) | undefined;
        if (!(setViewOffset && updateProjectionMatrix)) {
          throw new Error(
            `Camera type ${camera.type} does not support logical region rendering.`
          );
        }
        setViewOffset.call(
          camera,
          width,
          height,
          region.x,
          region.y,
          region.width,
          region.height
        );
        updateProjectionMatrix.call(camera);
        camera.updateMatrixWorld(true);

        const ownRenderer = !result.renderer;
        const renderer =
          result.renderer ??
          new THREE.WebGLRenderer({
            alpha: background === "transparent",
            antialias: true,
            preserveDrawingBuffer: true,
          });
        const renderedWidth = Math.round(region.width * scale);
        const renderedHeight = Math.round(region.height * scale);
        renderer.setPixelRatio(1);
        renderer.setSize(renderedWidth, renderedHeight, false);
        if (background && background !== "transparent") {
          renderer.setClearColor(background, 1);
        } else if (background === "transparent") {
          renderer.setClearColor(0x00_00_00, 0);
        }
        renderer.render(result.scene, camera);
        const canvas = renderer.domElement;
        canvas.dataset.uisceneOutput = "true";
        canvas.style.display = "block";
        canvas.style.height = `${renderedHeight}px`;
        canvas.style.width = `${renderedWidth}px`;
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        document.body.style.margin = "0";
        document.body.replaceChildren(canvas);
        Reflect.set(window, "__UISCENE_OUTPUT_RENDERER__", {
          ownRenderer,
          renderer,
        });
        return {
          renderedSize: {
            height: renderedHeight,
            width: renderedWidth,
          },
          renderMs: performance.now() - renderStartedAt,
        };
      },
      {
        background: options.background ?? null,
        height: options.height,
        region: options.region,
        scale: options.scale,
        width: options.width,
      }
    );

    const captureStartedAt = performance.now();
    await runtime.page
      .locator("canvas[data-uiscene-output='true']")
      .screenshot({
        animations: "disabled",
        caret: "hide",
        path: output,
        scale: "css",
        timeout: 120_000,
      });
    const captureMs = performance.now() - captureStartedAt;
    const outputNonempty = (await stat(output)).size > 0;
    const expected = {
      height: Math.round(options.region.height * options.scale),
      width: Math.round(options.region.width * options.scale),
    };
    const checks = {
      exportFound: true,
      moduleLoaded: true,
      outputNonempty,
      regionValid: true,
      requestedScaleAchieved:
        rendered.renderedSize.width === expected.width &&
        rendered.renderedSize.height === expected.height,
    };
    await runtime.page.evaluate(() => {
      const outputRuntime = Reflect.get(
        window,
        "__UISCENE_OUTPUT_RENDERER__"
      ) as
        | {
            ownRenderer: boolean;
            renderer: import("three").WebGLRenderer;
          }
        | undefined;
      if (outputRuntime?.ownRenderer) {
        outputRuntime.renderer.dispose();
      }
      Reflect.deleteProperty(window, "__UISCENE_OUTPUT_RENDERER__");
    });
    await disposeThree(runtime.page);
    return {
      artifact: output,
      checks,
      logicalSize: {
        height: options.region.height,
        width: options.region.width,
      },
      region: options.region,
      renderedSize: rendered.renderedSize,
      scale: options.scale,
      success: Object.values(checks).every(Boolean),
      timingsMs: {
        capture: captureMs,
        render: rendered.renderMs,
        total: performance.now() - totalStartedAt,
      },
    };
  } finally {
    await runtime.browser.close();
  }
}

export async function scoutThree(
  options: ThreeScoutOptions
): Promise<ScoutReport> {
  const totalStartedAt = performance.now();
  const runtime = await prepareThreePage({
    entry: options.entry,
    exportName: options.exportName,
    height: options.height,
    scale: 1,
    width: options.width,
  });
  const directory = resolve(options.out);
  const artifacts = {
    contactSheet: join(directory, "contact-sheet.png"),
    report: join(directory, "scout.json"),
    structure: join(directory, "structure.json"),
  };

  try {
    const scene = await extractThreeScene(runtime.page, options);
    const targetNode = scene.nodes.find((node) => node.id === options.nodeId);
    if (!targetNode) {
      throw new Error(`Target node not found: ${options.nodeId}`);
    }
    if (options.focusNodeId) {
      const focusNode = scene.nodes.find(
        (node) => node.id === options.focusNodeId
      );
      if (!focusNode) {
        throw new Error(`Focus node not found: ${options.focusNodeId}`);
      }
    }
    await mkdir(directory, { recursive: true });
    await writeFile(artifacts.structure, `${JSON.stringify(scene, null, 2)}\n`);

    const candidatePass = await runtime.page.evaluate(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Playwright must serialize this complete single-page transaction so Scout can reuse one source scene and renderer.
      function runScoutPass({
        background,
        focus,
        focusNodeId,
        height,
        isolate,
        nodeId,
        specs,
        width,
      }) {
        const passStartedAt = performance.now();
        const browserRuntime = Reflect.get(window, "__UISCENE_THREE__") as
          | {
              THREE: typeof import("three");
              result: {
                camera: import("three").Camera;
                renderer?: import("three").WebGLRenderer;
                scene: import("three").Scene;
              };
            }
          | undefined;
        if (!browserRuntime) {
          throw new Error("Three.js runtime was not created.");
        }
        const { THREE, result } = browserRuntime;
        result.scene.updateMatrixWorld(true);

        const findObject = (id: string): import("three").Object3D | null => {
          let found: import("three").Object3D | null = null;
          result.scene.traverse((object) => {
            if (object.userData.__uisceneRuntimeId === id) {
              found = object;
            }
          });
          return found;
        };
        const selectedTarget = findObject(nodeId);
        if (!selectedTarget) {
          throw new Error(`Target node not found: ${nodeId}`);
        }
        const targetBox = new THREE.Box3().setFromObject(selectedTarget);
        const targetSize = targetBox.getSize(new THREE.Vector3());
        const boundsValid =
          [targetSize.x, targetSize.y, targetSize.z].every(Number.isFinite) &&
          Math.max(targetSize.x, targetSize.y, targetSize.z) > 0;
        if (!boundsValid) {
          throw new Error(`Target node has empty bounds: ${nodeId}`);
        }
        const focusObject = focusNodeId ? findObject(focusNodeId) : null;
        if (focusNodeId && !focusObject) {
          throw new Error(`Focus node not found: ${focusNodeId}`);
        }
        let focusPoint = targetBox.getCenter(new THREE.Vector3());
        if (focusObject) {
          focusPoint = new THREE.Box3()
            .setFromObject(focusObject)
            .getCenter(new THREE.Vector3());
        }
        if (focus) {
          focusPoint = new THREE.Vector3(...focus);
        }

        const contains = (
          ancestor: import("three").Object3D,
          object: import("three").Object3D
        ): boolean => {
          let current: import("three").Object3D | null = object;
          while (current) {
            if (current === ancestor) {
              return true;
            }
            current = current.parent;
          }
          return false;
        };
        if (isolate) {
          result.scene.traverse((object) => {
            if (object === result.scene) {
              return;
            }
            object.visible =
              Reflect.get(object, "isLight") === true ||
              contains(object, selectedTarget) ||
              contains(selectedTarget, object);
          });
        }

        const targetRadius = Math.max(
          targetBox.getBoundingSphere(new THREE.Sphere()).radius,
          0.1
        );
        const framePerspectiveCamera = (
          perspective: import("three").PerspectiveCamera,
          view: { azimuth: number; elevation: number } | null,
          zoom: number,
          sceneCamera: boolean
        ): void => {
          perspective.aspect = width / height;
          if (sceneCamera) {
            perspective.updateProjectionMatrix();
            perspective.updateMatrixWorld(true);
            return;
          }
          const direction = view
            ? new THREE.Vector3(
                Math.cos(THREE.MathUtils.degToRad(view.elevation)) *
                  Math.cos(THREE.MathUtils.degToRad(view.azimuth)),
                Math.cos(THREE.MathUtils.degToRad(view.elevation)) *
                  Math.sin(THREE.MathUtils.degToRad(view.azimuth)),
                Math.sin(THREE.MathUtils.degToRad(view.elevation))
              )
            : perspective.position.clone().sub(focusPoint);
          if (direction.lengthSq() === 0) {
            direction.set(1, -1, 1);
          }
          direction.normalize();
          const halfFov = THREE.MathUtils.degToRad(perspective.fov / 2);
          const distance =
            ((targetRadius / Math.sin(halfFov)) * 1.25) / Math.max(zoom, 0.001);
          perspective.position
            .copy(focusPoint)
            .addScaledVector(direction, distance);
          perspective.near = Math.max(0.01, distance - targetRadius * 4);
          perspective.far = Math.max(
            perspective.near + 1,
            distance + targetRadius * 8
          );
          perspective.lookAt(focusPoint);
          perspective.updateProjectionMatrix();
          perspective.updateMatrixWorld(true);
        };
        const frameOrthographicCamera = (
          orthographic: import("three").OrthographicCamera,
          zoom: number,
          sceneCamera: boolean
        ): void => {
          if (!sceneCamera) {
            const extent = (targetRadius * 1.4) / Math.max(zoom, 0.001);
            orthographic.left = -extent * (width / height);
            orthographic.right = extent * (width / height);
            orthographic.top = extent;
            orthographic.bottom = -extent;
            orthographic.lookAt(focusPoint);
          }
          orthographic.updateProjectionMatrix();
          orthographic.updateMatrixWorld(true);
        };
        const frameCamera = (
          camera: import("three").Camera,
          view: { azimuth: number; elevation: number } | null,
          zoom: number,
          sceneCamera: boolean
        ): void => {
          if (Reflect.get(camera, "isPerspectiveCamera")) {
            framePerspectiveCamera(
              camera as import("three").PerspectiveCamera,
              view,
              zoom,
              sceneCamera
            );
            return;
          }
          if (Reflect.get(camera, "isOrthographicCamera")) {
            frameOrthographicCamera(
              camera as import("three").OrthographicCamera,
              zoom,
              sceneCamera
            );
          }
        };

        const boxCorners = (
          box: import("three").Box3
        ): import("three").Vector3[] => [
          new THREE.Vector3(box.min.x, box.min.y, box.min.z),
          new THREE.Vector3(box.min.x, box.min.y, box.max.z),
          new THREE.Vector3(box.min.x, box.max.y, box.min.z),
          new THREE.Vector3(box.min.x, box.max.y, box.max.z),
          new THREE.Vector3(box.max.x, box.min.y, box.min.z),
          new THREE.Vector3(box.max.x, box.min.y, box.max.z),
          new THREE.Vector3(box.max.x, box.max.y, box.min.z),
          new THREE.Vector3(box.max.x, box.max.y, box.max.z),
        ];
        const projectedMetrics = (camera: import("three").Camera) => {
          const screen = boxCorners(targetBox).map((corner) => {
            const depth = -corner
              .clone()
              .applyMatrix4(camera.matrixWorldInverse).z;
            const projected = corner.clone().project(camera);
            return {
              depth,
              x: ((projected.x + 1) / 2) * width,
              y: ((1 - projected.y) / 2) * height,
            };
          });
          const xs = screen.map((point) => point.x);
          const ys = screen.map((point) => point.y);
          const depths = screen
            .map((point) => point.depth)
            .filter(Number.isFinite);
          const minimumX = Math.min(...xs);
          const maximumX = Math.max(...xs);
          const minimumY = Math.min(...ys);
          const maximumY = Math.max(...ys);
          const intersectionWidth = Math.max(
            0,
            Math.min(width, maximumX) - Math.max(0, minimumX)
          );
          const intersectionHeight = Math.max(
            0,
            Math.min(height, maximumY) - Math.max(0, minimumY)
          );
          const clippedEdges: Array<"bottom" | "left" | "right" | "top"> = [];
          if (minimumX < 0) {
            clippedEdges.push("left");
          }
          if (maximumX > width) {
            clippedEdges.push("right");
          }
          if (minimumY < 0) {
            clippedEdges.push("top");
          }
          if (maximumY > height) {
            clippedEdges.push("bottom");
          }
          return {
            cameraDepthRange: {
              max: depths.length > 0 ? Math.max(...depths) : 0,
              min: depths.length > 0 ? Math.min(...depths) : 0,
            },
            clippedEdges,
            targetCoverage:
              (intersectionWidth * intersectionHeight) / (width * height),
          };
        };

        const copyCanvas = (source: HTMLCanvasElement): HTMLCanvasElement => {
          const copy = document.createElement("canvas");
          copy.height = height;
          copy.width = width;
          const context = copy.getContext("2d", { willReadFrequently: true });
          if (!context) {
            throw new Error("A 2D canvas is required for Scout analysis.");
          }
          context.drawImage(source, 0, 0, width, height);
          return copy;
        };
        const readPixelEvidence = (canvas: HTMLCanvasElement) => {
          const context = canvas.getContext("2d", {
            willReadFrequently: true,
          });
          if (!context) {
            throw new Error("A 2D canvas is required for Scout analysis.");
          }
          const pixels = context.getImageData(0, 0, width, height).data;
          const colorCounts = new Map<string, number>();
          const luminances = new Float32Array(width * height);
          let maximumLuminance = 0;
          let minimumLuminance = 1;
          let luminanceSum = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            const alpha = pixels[index + 3] ?? 0;
            const colorKey = `${red},${green},${blue},${alpha}`;
            colorCounts.set(colorKey, (colorCounts.get(colorKey) ?? 0) + 1);
            const luminance =
              (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
            const pixelIndex = index / 4;
            luminances[pixelIndex] = luminance;
            luminanceSum += luminance;
            maximumLuminance = Math.max(maximumLuminance, luminance);
            minimumLuminance = Math.min(minimumLuminance, luminance);
          }
          return {
            colorCounts,
            luminanceSum,
            luminances,
            maximumLuminance,
            minimumLuminance,
            pixels,
          };
        };
        const dominantColorComponents = (
          colorCounts: Map<string, number>
        ): number[] => {
          const [dominant] = [...colorCounts.entries()].sort(
            (left, right) => right[1] - left[1]
          );
          return (dominant?.[0] ?? "0,0,0,0").split(",").map(Number);
        };
        const isEdgePixel = (
          index: number,
          luminances: Float32Array
        ): boolean => {
          const current = luminances[index] ?? 0;
          const x = index % width;
          const y = Math.floor(index / width);
          const right =
            x + 1 < width ? (luminances[index + 1] ?? current) : current;
          const below =
            y + 1 < height ? (luminances[index + width] ?? current) : current;
          return (
            Math.abs(current - right) > 0.025 ||
            Math.abs(current - below) > 0.025
          );
        };
        const measurePixelSignal = (
          evidence: ReturnType<typeof readPixelEvidence>
        ) => {
          const {
            colorCounts,
            luminances,
            luminanceSum,
            maximumLuminance,
            minimumLuminance,
            pixels,
          } = evidence;
          const dominantComponents = dominantColorComponents(colorCounts);
          let backgroundPixels = 0;
          let edgePixels = 0;
          let squaredDifferenceSum = 0;
          const mean = luminanceSum / Math.max(1, luminances.length);
          for (let index = 0; index < luminances.length; index += 1) {
            const current = luminances[index] ?? 0;
            const difference = current - mean;
            squaredDifferenceSum += difference * difference;
            const offset = index * 4;
            const colorDistance = Math.hypot(
              (pixels[offset] ?? 0) - (dominantComponents[0] ?? 0),
              (pixels[offset + 1] ?? 0) - (dominantComponents[1] ?? 0),
              (pixels[offset + 2] ?? 0) - (dominantComponents[2] ?? 0),
              ((pixels[offset + 3] ?? 0) - (dominantComponents[3] ?? 0)) * 0.5
            );
            if (colorDistance <= 4) {
              backgroundPixels += 1;
            }
            if (isEdgePixel(index, luminances)) {
              edgePixels += 1;
            }
          }
          const totalPixels = Math.max(1, luminances.length);
          const backgroundFraction = backgroundPixels / totalPixels;
          return {
            backgroundFraction,
            contrastStdDev: Math.sqrt(squaredDifferenceSum / totalPixels),
            edgeDensity: edgePixels / totalPixels,
            luminanceRange: {
              max: maximumLuminance,
              min: minimumLuminance,
            },
            visiblePixelFraction: 1 - backgroundFraction,
          };
        };
        const pixelMetrics = (canvas: HTMLCanvasElement) =>
          measurePixelSignal(readPixelEvidence(canvas));
        const candidateScore = (metrics: {
          clippedEdges: string[];
          contrastStdDev: number;
          edgeDensity: number;
          targetCoverage: number;
          visiblePixelFraction: number;
        }): number => {
          const coverageUtility = Math.max(
            0,
            1 - Math.abs(Math.min(1, metrics.targetCoverage) - 0.55) / 0.55
          );
          const signal = Math.min(1, metrics.visiblePixelFraction * 8);
          const contrast = Math.min(1, metrics.contrastStdDev * 10);
          const edges = Math.min(1, metrics.edgeDensity * 12);
          const clippingPenalty = metrics.clippedEdges.length * 0.08;
          return Math.max(
            0,
            signal * 0.4 +
              contrast * 0.25 +
              coverageUtility * 0.25 +
              edges * 0.1 -
              clippingPenalty
          );
        };

        const ownRenderer = !result.renderer;
        const renderer =
          result.renderer ??
          new THREE.WebGLRenderer({
            alpha: background === "transparent",
            antialias: true,
            powerPreference: "high-performance",
            preserveDrawingBuffer: true,
          });
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        if (background && background !== "transparent") {
          renderer.setClearColor(background, 1);
        } else if (background === "transparent") {
          renderer.setClearColor(0x00_00_00, 0);
        }

        const previews: Array<{
          candidate: {
            camera: {
              azimuth?: number;
              elevation?: number;
              position: number[];
              target: number[];
            };
            id: string;
            metrics: ReturnType<typeof pixelMetrics> &
              ReturnType<typeof projectedMetrics>;
            score: number;
            timingsMs: { render: number };
            view: string;
            zoom: number;
          };
          canvas: HTMLCanvasElement;
        }> = [];
        for (const spec of specs) {
          const camera = result.camera.clone();
          frameCamera(camera, spec.view, spec.zoom, spec.sceneCamera);
          const renderStartedAt = performance.now();
          renderer.render(result.scene, camera);
          const renderMs = performance.now() - renderStartedAt;
          const canvas = copyCanvas(renderer.domElement);
          const metrics = {
            ...pixelMetrics(canvas),
            ...projectedMetrics(camera),
          };
          previews.push({
            candidate: {
              camera: {
                ...(spec.view
                  ? {
                      azimuth: spec.view.azimuth,
                      elevation: spec.view.elevation,
                    }
                  : {}),
                position: camera.position.toArray(),
                target: focusPoint.toArray(),
              },
              id: spec.id,
              metrics,
              score: candidateScore(metrics),
              timingsMs: { render: renderMs },
              view: spec.view?.label ?? "original",
              zoom: spec.zoom,
            },
            canvas,
          });
        }

        const sheet = document.createElement("main");
        sheet.dataset.uisceneScout = "true";
        sheet.style.background = "#0b0d14";
        sheet.style.color = "#e5e7eb";
        sheet.style.display = "grid";
        sheet.style.fontFamily =
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        sheet.style.gap = "12px";
        sheet.style.gridTemplateColumns = `repeat(3, ${width}px)`;
        sheet.style.padding = "16px";
        sheet.style.width = "max-content";
        const heading = document.createElement("header");
        heading.style.gridColumn = "1 / -1";
        heading.style.padding = "0 2px 4px";
        const title = document.createElement("strong");
        title.textContent = `SceneProof scout · ${nodeId}`;
        const subtitle = document.createElement("div");
        subtitle.style.color = "#9ca3af";
        subtitle.style.fontSize = "12px";
        subtitle.style.marginTop = "4px";
        subtitle.textContent = `focus ${focusPoint
          .toArray()
          .map((value) => Number(value.toFixed(3)))
          .join(", ")} · ${width}×${height}`;
        heading.append(title, subtitle);
        sheet.append(heading);
        for (const preview of previews) {
          const card = document.createElement("section");
          card.style.background = "#121621";
          card.style.border = "1px solid #252b3a";
          card.style.borderRadius = "8px";
          card.style.overflow = "hidden";
          preview.canvas.style.display = "block";
          preview.canvas.style.height = `${height}px`;
          preview.canvas.style.width = `${width}px`;
          const label = document.createElement("div");
          label.style.fontSize = "11px";
          label.style.lineHeight = "1.45";
          label.style.padding = "8px 10px";
          label.textContent = `${preview.candidate.id} · score ${preview.candidate.score.toFixed(
            3
          )} · coverage ${(
            preview.candidate.metrics.targetCoverage * 100
          ).toFixed(1)}% · visible ${(
            preview.candidate.metrics.visiblePixelFraction * 100
          ).toFixed(1)}%`;
          card.append(preview.canvas, label);
          sheet.append(card);
        }
        document.documentElement.style.background = "#0b0d14";
        document.body.style.background = "#0b0d14";
        document.body.style.margin = "0";
        document.body.replaceChildren(sheet);
        Reflect.set(window, "__UISCENE_SCOUT_RENDERER__", {
          ownRenderer,
          renderer,
        });

        let focusSource: "node" | "point" | "target" = "target";
        if (focus) {
          focusSource = "point";
        }
        if (focusNodeId) {
          focusSource = "node";
        }
        return {
          candidatePassMs: performance.now() - passStartedAt,
          candidates: previews.map((preview) => preview.candidate),
          focus: {
            ...(focusNodeId ? { nodeId: focusNodeId } : {}),
            source: focusSource,
            worldPosition: focusPoint
              .toArray()
              .map((value) => Number(value.toFixed(9))),
          },
        };
      },
      {
        background: options.background ?? null,
        focus: options.focus ?? null,
        focusNodeId: options.focusNodeId ?? null,
        height: options.height,
        isolate: options.isolate ?? true,
        nodeId: options.nodeId,
        specs: scoutCandidateSpecs(),
        width: options.width,
      }
    );

    const captureStartedAt = performance.now();
    await runtime.page.locator("main[data-uiscene-scout='true']").screenshot({
      animations: "disabled",
      caret: "hide",
      path: artifacts.contactSheet,
      scale: "css",
      timeout: 120_000,
    });
    const captureMs = performance.now() - captureStartedAt;
    await runtime.page.evaluate(() => {
      const outputRuntime = Reflect.get(window, "__UISCENE_SCOUT_RENDERER__") as
        | {
            ownRenderer: boolean;
            renderer: import("three").WebGLRenderer;
          }
        | undefined;
      if (outputRuntime?.ownRenderer) {
        outputRuntime.renderer.dispose();
      }
      Reflect.deleteProperty(window, "__UISCENE_SCOUT_RENDERER__");
    });

    const candidates = candidatePass.candidates as ScoutCandidate[];
    const ordered = [...candidates].sort(
      (left, right) => right.score - left.score
    );
    const structuralWarning = scene.warnings.find(
      (warning) =>
        warning.startsWith(options.nodeId) &&
        warning.toLowerCase().includes("invisible")
    );
    const recommendedCandidate = structuralWarning ? undefined : ordered[0];
    const resolvedFocus = {
      ...candidatePass.focus,
      worldPosition: candidatePass.focus.worldPosition as [
        number,
        number,
        number,
      ],
    } as ScoutReport["focus"];
    const recommended = structuralWarning
      ? {
          candidateId: null,
          detailCommand: null,
          reason: [
            `Structural diagnostics must be resolved before camera or scale changes: ${structuralWarning}`,
          ],
        }
      : {
          candidateId: recommendedCandidate?.id ?? null,
          detailCommand: recommendedCandidate
            ? detailCommand({
                candidate: recommendedCandidate,
                entry: options.entry,
                exportName: options.exportName,
                focus: resolvedFocus.worldPosition,
                height: options.height,
                isolate: options.isolate ?? true,
                nodeId: options.nodeId,
                width: options.width,
              })
            : null,
          reason: recommendedCandidate
            ? [
                "Highest combined visible signal, contrast, target coverage, and edge evidence after clipping penalties.",
                `Candidate ${recommendedCandidate.id} places ${(
                  recommendedCandidate.metrics.visiblePixelFraction * 100
                ).toFixed(1)}% non-background pixels in the discovery frame.`,
              ]
            : ["No viable candidate was produced."],
        };
    const geometry = Reflect.get(targetNode, "geometry") as
      | { vertexCount?: unknown }
      | undefined;
    const vertexCount =
      typeof geometry?.vertexCount === "number"
        ? geometry.vertexCount
        : undefined;
    const report: ScoutReport = {
      artifacts,
      candidates,
      focus: resolvedFocus,
      lifecycle: {
        browserLaunches: 1,
        bundles: 1,
        sceneInstances: 1,
      },
      recommended,
      success:
        candidates.length > 0 && (await stat(artifacts.contactSheet)).size > 0,
      target: {
        id: options.nodeId,
        kind: targetNode.kind,
        ...(vertexCount === undefined ? {} : { vertexCount }),
      },
      timingsMs: {
        candidates: candidatePass.candidatePassMs,
        capture: captureMs,
        total: performance.now() - totalStartedAt,
      },
      warnings: scene.warnings,
    };
    await writeFile(artifacts.report, `${JSON.stringify(report, null, 2)}\n`);
    await disposeThree(runtime.page);
    return report;
  } finally {
    await runtime.browser.close();
  }
}
