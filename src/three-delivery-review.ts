import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { launchBrowser, mountBundle } from "./browser-runtime.js";
import { executionStatus } from "./report-status.js";
import { bundleBrowserDriver } from "./source-bundle.js";
import { driverSource, renderThree } from "./three-renderer.js";

type RenderThreeOptions = Parameters<typeof renderThree>[0];

type DeliveryReviewOptions = Omit<
  RenderThreeOptions,
  | "deliveryScale"
  | "focus"
  | "framing"
  | "out"
  | "preparedPage"
  | "preserveFixture"
  | "projection"
  | "view"
  | "zoom"
> & {
  out: string;
  requestedHeightPx: number;
};

export async function renderThreeDeliveryReview(
  options: DeliveryReviewOptions
) {
  const directory = resolve(options.out);
  const deliveryArtifact = join(directory, "delivery.png");
  const detailArtifact = join(directory, "detail.png");
  const contactSheet = join(directory, "delivery-review.png");
  const manifest = join(directory, "delivery-review.json");
  await mkdir(directory, { recursive: true });
  const bundle = await bundleBrowserDriver({
    aliases: options.aliases,
    discoverCss: false,
    entry: options.entry,
    extraCss: [],
    source: driverSource({
      ...options,
      framing: "source",
      out: deliveryArtifact,
      projection: "source",
      zoom: 1,
    }),
    ...(options.threeBackend ? { threeBackend: options.threeBackend } : {}),
  });
  const browser = await launchBrowser({
    threeBackend: options.threeBackend ?? "webgl",
  });
  try {
    const context = await browser.newContext({
      viewport: { height: options.height, width: options.width },
    });
    const page = await context.newPage();
    await mountBundle({ css: "", javascript: bundle.javascript, page });
    const delivery = await renderThree({
      ...options,
      deliveryScale: options.requestedHeightPx,
      framing: "source",
      inContext: false,
      isolate: false,
      out: deliveryArtifact,
      preparedPage: page,
      preserveFixture: true,
      projection: "source",
      zoom: 1,
    });
    const detail = await renderThree({
      ...options,
      framing: "fit",
      inContext: false,
      isolate: false,
      out: detailArtifact,
      preparedPage: page,
      preserveFixture: false,
      projection: "source",
      zoom: 1,
    });
    await page.close();

    const sources = await Promise.all(
      [deliveryArtifact, detailArtifact].map(
        async (artifact) =>
          `data:image/png;base64,${(await readFile(artifact)).toString("base64")}`
      )
    );
    const contactPage = await context.newPage();
    const pixelWidth = Math.round(options.width * options.scale);
    const pixelHeight = Math.round(options.height * options.scale);
    await contactPage.setViewportSize({
      height: pixelHeight + 28,
      width: pixelWidth * 2,
    });
    await contactPage.evaluate(
      async ({ height, imageSources, width }) => {
        const main = document.createElement("main");
        main.dataset.sceneproofDeliveryReview = "true";
        main.style.display = "flex";
        main.style.margin = "0";
        for (const [index, source] of imageSources.entries()) {
          const tile = document.createElement("section");
          tile.style.background = "#11111b";
          tile.style.color = "#f4f4f5";
          tile.style.font = "12px monospace";
          const label = document.createElement("div");
          label.style.boxSizing = "border-box";
          label.style.height = "28px";
          label.style.padding = "6px 8px";
          label.textContent =
            index === 0 ? "literal delivery" : "fitted detail";
          const image = new Image();
          image.height = height;
          image.src = source;
          image.width = width;
          // biome-ignore lint/performance/noAwaitInLoops: Decode order preserves delivery and detail attribution.
          await image.decode();
          tile.append(label, image);
          main.append(tile);
        }
        document.body.style.margin = "0";
        document.body.replaceChildren(main);
      },
      { height: pixelHeight, imageSources: sources, width: pixelWidth }
    );
    await contactPage
      .locator("main[data-sceneproof-delivery-review='true']")
      .screenshot({ path: contactSheet, scale: "css", timeout: 120_000 });
    await contactPage.close();

    const assertion = delivery.quality?.deliveryScale;
    if (!assertion) {
      throw new Error("Delivery review did not produce a height assertion.");
    }
    const executionSucceeded =
      delivery.success && detail.success && (await stat(contactSheet)).size > 0;
    const report = {
      artifacts: {
        contactSheet,
        delivery: deliveryArtifact,
        detail: detailArtifact,
        manifest,
      },
      assertion: {
        actualHeightPx: assertion.actualHeightPx,
        requestedHeightPx: assertion.requestedHeightPx,
        satisfied: assertion.satisfied,
        toleranceFraction: assertion.toleranceFraction,
      },
      assessment: {
        decisionOwner: "sceneproof-assertion" as const,
        objective: "delivery-scale" as const,
        reasons: [
          assertion.satisfied
            ? "The literal source-camera delivery height is within tolerance."
            : "The literal source-camera delivery height is outside tolerance; the detail panel remains review evidence, not a substitute delivery view.",
        ],
        verdict: assertion.satisfied
          ? ("passed" as const)
          : ("failed" as const),
      },
      command: "render-delivery-review" as const,
      execution: executionStatus(executionSucceeded),
      ...(delivery.graphics ? { graphics: delivery.graphics } : {}),
      lifecycle: {
        browserLaunches: 1 as const,
        bundles: 1 as const,
        sceneInstances: 1 as const,
        views: 2 as const,
      },
      provenance: {
        aliases: options.aliases,
        entry: options.entry,
        export: options.exportName,
        fixture: options.fixture,
      },
      success: executionSucceeded,
      variants: { delivery, detail },
      warnings: [
        ...new Set([...(delivery.warnings ?? []), ...(detail.warnings ?? [])]),
      ],
    };
    await writeFile(manifest, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await browser.close();
  }
}
