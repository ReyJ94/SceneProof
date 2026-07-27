import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { launchBrowser, mountBundle } from "./browser-runtime.js";
import {
  type LogicalRegion,
  type RegionRenderReport,
  type RenderReport,
  type SceneArtifact,
  SceneArtifactSchema,
} from "./scene-schema.js";
import { bundleBrowserDriver } from "./source-bundle.js";

type ReactOptions = {
  entry: string;
  exportName: string;
  props: Record<string, unknown>;
  width: number;
  height: number;
  css: readonly string[];
};

function driverSource(input: ReactOptions): string {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    import * as SourceModule from ${JSON.stringify(input.entry)};

    const selected = SourceModule[${JSON.stringify(input.exportName)}];
    window.__UISCENE_STATUS__ = {
      moduleLoaded: true,
      exportFound: selected !== undefined,
    };
    if (selected === undefined) {
      window.__UISCENE_ERROR__ =
        "Requested export ${input.exportName.replaceAll('"', '\\"')} not found in ${input.entry.replaceAll('"', '\\"')}";
    } else {
      try {
        const root = createRoot(document.getElementById("uiscene-root"));
        flushSync(() => {
          root.render(React.createElement(selected, ${JSON.stringify(input.props)}));
        });
        Promise.resolve(document.fonts?.ready)
          .then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
          .then(() => {
            window.__UISCENE_READY__ = true;
          });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        window.__UISCENE_ERROR__ =
          "React export ${input.exportName.replaceAll('"', '\\"')} failed to render with the provided props: " +
          detail +
          ". Supply the component fixture with --props <file>; the reported property name identifies the nearest missing access.";
      }
    }
  `;
}

async function prepareReactPage(
  options: ReactOptions,
  scale: number
): Promise<{
  browser: Awaited<ReturnType<typeof launchBrowser>>;
  page: import("playwright-core").Page;
}> {
  const bundle = await bundleBrowserDriver({
    entry: options.entry,
    extraCss: options.css,
    source: driverSource(options),
  });
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      deviceScaleFactor: scale,
      viewport: { height: options.height, width: options.width },
    });
    const page = await context.newPage();
    try {
      await mountBundle({
        css: bundle.css,
        javascript: bundle.javascript,
        page,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `React export ${options.exportName} failed to render with the provided props: ${detail} Supply the component fixture with --props <file>; the reported property name identifies the nearest missing access.`,
        { cause: error }
      );
    }
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function extractDomScene(
  page: import("playwright-core").Page,
  options: ReactOptions
): Promise<SceneArtifact> {
  const artifact = await page.evaluate(
    ({ entry, exportName, width, height }) => {
      const mount = document.querySelector("#uiscene-root");
      if (!mount) {
        throw new Error("React mount root was not created.");
      }

      const allElements: Element[] = [];
      const visit = (element: Element): void => {
        allElements.push(element);
        for (const child of element.children) {
          visit(child);
        }
      };
      for (const root of mount.children) {
        visit(root);
      }

      const used = new Map<string, number>();
      const runtimeIds = new Map<Element, string>();
      const clean = (value: string): string =>
        value
          .normalize("NFKD")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 64);
      const directText = (element: Element): string =>
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      const stablePath = (element: Element): string => {
        const parts: number[] = [];
        let current: Element | null = element;
        while (current?.parentElement && current.parentElement !== mount) {
          parts.unshift(
            Array.from(current.parentElement.children).indexOf(current)
          );
          current = current.parentElement;
        }
        if (current) {
          parts.unshift(Array.from(mount.children).indexOf(current));
        }
        return parts.join(".");
      };
      const implicitRole = (element: Element): string | null => {
        const explicit = element.getAttribute("role");
        if (explicit) {
          return explicit;
        }
        const tag = element.tagName.toLowerCase();
        if (tag === "button") {
          return "button";
        }
        if (tag === "a" && element.hasAttribute("href")) {
          return "link";
        }
        if (
          tag.length === 2 &&
          tag.startsWith("h") &&
          "123456".includes(tag.at(1) ?? "")
        ) {
          return "heading";
        }
        if (tag === "nav") {
          return "navigation";
        }
        return null;
      };

      for (const element of allElements) {
        const prefix =
          element.namespaceURI === "http://www.w3.org/2000/svg" ? "svg" : "dom";
        const explicit =
          element.getAttribute("data-sceneproof-id") ??
          element.getAttribute("data-uiscene-id");
        const htmlId = element.getAttribute("id");
        const role = implicitRole(element);
        const text = directText(element);
        const semantic =
          (explicit && clean(explicit)) ||
          (htmlId && clean(htmlId)) ||
          (role && text && `${clean(role)}-${clean(text)}`) ||
          `${element.tagName.toLowerCase()}-${stablePath(element)}`;
        const base = `${prefix}:${semantic}`;
        const count = (used.get(base) ?? 0) + 1;
        used.set(base, count);
        const id = count === 1 ? base : `${base}~${count}`;
        runtimeIds.set(element, id);
        element.setAttribute("data-uiscene-runtime-id", id);
      }

      const usefulStyles = [
        "display",
        "position",
        "flexDirection",
        "alignItems",
        "justifyContent",
        "gap",
        "width",
        "height",
        "padding",
        "margin",
        "backgroundColor",
        "color",
        "border",
        "borderRadius",
        "boxShadow",
        "fontFamily",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "opacity",
        "overflow",
        "transform",
      ] as const;
      const round = (value: number): number =>
        Math.round((value + Number.EPSILON) * 1000) / 1000;
      const stylesFor = (element: Element): Record<string, string> => {
        const computed = getComputedStyle(element);
        const styles: Record<string, string> = {};
        for (const property of usefulStyles) {
          const value = computed[property];
          if (value && value !== "none" && value !== "normal") {
            styles[property] = value;
          }
        }
        return styles;
      };
      const textFor = (element: Element): string => {
        const renderedText = Reflect.get(element, "innerText");
        return (
          typeof renderedText === "string"
            ? renderedText
            : (element.textContent ?? "")
        )
          .replace(/\s+/g, " ")
          .trim();
      };
      const elementNodes = allElements.map((element) => {
        const id = runtimeIds.get(element);
        if (!id) {
          throw new Error("DOM node identity assignment failed.");
        }
        const rect = element.getBoundingClientRect();
        const text = textFor(element);
        const parent =
          element.parentElement && element.parentElement !== mount
            ? (runtimeIds.get(element.parentElement) ?? null)
            : null;
        return {
          bounds: {
            height: round(rect.height),
            width: round(rect.width),
            x: round(rect.x),
            y: round(rect.y),
          },
          children: Array.from(element.children)
            .map((child) => runtimeIds.get(child))
            .filter((child): child is string => Boolean(child)),
          id,
          kind: "element",
          parent,
          styles: stylesFor(element),
          tag: element.tagName.toLowerCase(),
          ...(text ? { text } : {}),
          source: { export: exportName, file: entry },
        };
      });
      const rootIds = Array.from(mount.children)
        .map((element) => runtimeIds.get(element))
        .filter((id): id is string => Boolean(id));
      const componentId = `react:${exportName}`;
      const nodes = [
        {
          children: rootIds,
          id: componentId,
          kind: "component",
          name: exportName,
          source: { export: exportName, file: entry },
        },
        ...elementNodes,
      ];
      const relationships = nodes.flatMap((node) =>
        node.children.map((child) => ({
          from: node.id,
          kind: "parent-child" as const,
          to: child,
        }))
      );
      return {
        assets: [],
        entry,
        export: exportName,
        nodes,
        relationships,
        root: componentId,
        rootIds,
        version: 1 as const,
        viewport: { height, width },
        warnings: [],
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

export async function inspectReact(
  options: ReactOptions
): Promise<SceneArtifact> {
  const runtime = await prepareReactPage(options, 1);
  try {
    return await extractDomScene(runtime.page, options);
  } finally {
    await runtime.browser.close();
  }
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("Renderer output is not a PNG.");
  }
  return {
    height: bytes.readUInt32BE(20),
    width: bytes.readUInt32BE(16),
  };
}

export function hasRequestedScale(
  rendered: { width: number; height: number },
  logical: { width: number; height: number },
  scale: number
): boolean {
  const dimensionAchieved = (pixels: number, cssPixels: number) =>
    pixels >= cssPixels * scale && pixels <= Math.ceil(cssPixels) * scale;
  return (
    dimensionAchieved(rendered.width, logical.width) &&
    dimensionAchieved(rendered.height, logical.height)
  );
}

export async function renderReact(
  options: ReactOptions & {
    nodeId: string;
    out: string;
    scale: number;
  }
): Promise<RenderReport> {
  const runtime = await prepareReactPage(options, options.scale);
  const output = resolve(options.out);
  try {
    const scene = await extractDomScene(runtime.page, options);
    const node = scene.nodes.find(
      (candidate) => candidate.id === options.nodeId
    );
    if (!node) {
      throw new Error(`Target node not found: ${options.nodeId}`);
    }
    const bounds = node.bounds as { width: number; height: number } | undefined;
    const boundsValid = Boolean(
      bounds && bounds.width > 0 && bounds.height > 0
    );
    if (!(boundsValid && bounds)) {
      throw new Error(`Target node has empty bounds: ${options.nodeId}`);
    }

    await mkdir(dirname(output), { recursive: true });
    const locator = runtime.page.locator(
      `[data-uiscene-runtime-id=${JSON.stringify(options.nodeId)}]`
    );
    await locator.screenshot({ path: output, scale: "device" });
    const bytes = await readFile(output);
    const renderedSize = pngDimensions(bytes);
    const requestedScaleAchieved = hasRequestedScale(
      renderedSize,
      bounds,
      options.scale
    );
    const outputNonempty = (await stat(output)).size > 0;
    const checks = {
      boundsValid,
      exportFound: true,
      moduleLoaded: true,
      outputNonempty,
      requestedScaleAchieved,
      targetFound: true,
    };
    return {
      artifact: output,
      checks,
      logicalSize: {
        height: bounds.height,
        width: bounds.width,
      },
      nodeId: options.nodeId,
      renderedSize,
      scale: options.scale,
      success: Object.values(checks).every(Boolean),
    };
  } finally {
    await runtime.browser.close();
  }
}

export async function renderReactRegion(
  options: ReactOptions & {
    region: LogicalRegion;
    out: string;
    scale: number;
  }
): Promise<RegionRenderReport> {
  const runtime = await prepareReactPage(options, options.scale);
  const output = resolve(options.out);
  try {
    await mkdir(dirname(output), { recursive: true });
    await runtime.page.screenshot({
      clip: options.region,
      path: output,
      scale: "device",
    });
    const bytes = await readFile(output);
    const renderedSize = pngDimensions(bytes);
    const expected = {
      height: Math.round(options.region.height * options.scale),
      width: Math.round(options.region.width * options.scale),
    };
    const outputNonempty = (await stat(output)).size > 0;
    const checks = {
      exportFound: true,
      moduleLoaded: true,
      outputNonempty,
      regionValid: true,
      requestedScaleAchieved:
        renderedSize.width === expected.width &&
        renderedSize.height === expected.height,
    };
    return {
      artifact: output,
      checks,
      logicalSize: {
        height: options.region.height,
        width: options.region.width,
      },
      region: options.region,
      renderedSize,
      scale: options.scale,
      success: Object.values(checks).every(Boolean),
    };
  } finally {
    await runtime.browser.close();
  }
}
