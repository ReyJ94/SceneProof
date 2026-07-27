import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { launchBrowser, mountBundle } from "./browser-runtime.js";
import { executionStatus } from "./report-status.js";
import { bundleBrowserDriver } from "./source-bundle.js";
import { driverSource, renderThree } from "./three-renderer.js";

type RenderThreeOptions = Parameters<typeof renderThree>[0];

type ContextPairOptions = Omit<
  RenderThreeOptions,
  "inContext" | "isolate" | "out" | "preparedPage" | "preserveFixture"
> & { out: string };

export async function renderThreeContextPair(options: ContextPairOptions) {
  const requested = resolve(options.out);
  const contactSheetIsFile = extname(requested).toLowerCase() === ".png";
  const directory = contactSheetIsFile
    ? join(
        dirname(requested),
        `${basename(requested, extname(requested))}-context`
      )
    : requested;
  const contactSheet = contactSheetIsFile
    ? requested
    : join(directory, "context-pair.png");
  const inContextArtifact = join(directory, "in-context.png");
  const isolatedArtifact = join(directory, "isolated.png");
  const manifest = join(directory, "context-pair.json");
  await mkdir(directory, { recursive: true });

  const bundle = await bundleBrowserDriver({
    entry: options.entry,
    extraCss: [],
    source: driverSource(options),
  });
  const browser = await launchBrowser();
  try {
    const browserContext = await browser.newContext({
      viewport: { height: options.height, width: options.width },
    });
    const page = await browserContext.newPage();
    await mountBundle({ css: "", javascript: bundle.javascript, page });
    const inContext = await renderThree({
      ...options,
      inContext: true,
      isolate: false,
      out: inContextArtifact,
      preparedPage: page,
      preserveFixture: true,
    });
    const isolated = await renderThree({
      ...options,
      inContext: false,
      isolate: true,
      out: isolatedArtifact,
      preparedPage: page,
      preserveFixture: false,
    });
    await page.close();

    const sources = await Promise.all(
      [inContextArtifact, isolatedArtifact].map(
        async (artifact) =>
          `data:image/png;base64,${(await readFile(artifact)).toString("base64")}`
      )
    );
    const contactPage = await browserContext.newPage();
    await contactPage.setViewportSize({
      height: options.height + 28,
      width: options.width * 2,
    });
    await contactPage.evaluate(
      async ({ height, imageSources, width }) => {
        const main = document.createElement("main");
        main.dataset.sceneproofContextPair = "true";
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
          label.textContent = index === 0 ? "in context" : "isolated";
          const image = new Image();
          image.height = height;
          image.src = source;
          image.width = width;
          // biome-ignore lint/performance/noAwaitInLoops: Decode order preserves exact label-to-image attribution.
          await image.decode();
          tile.append(label, image);
          main.append(tile);
        }
        document.body.style.margin = "0";
        document.body.replaceChildren(main);
      },
      { height: options.height, imageSources: sources, width: options.width }
    );
    await contactPage
      .locator("main[data-sceneproof-context-pair='true']")
      .screenshot({ path: contactSheet, scale: "css" });
    await contactPage.close();

    const executionSucceeded =
      inContext.success &&
      isolated.success &&
      (await stat(contactSheet)).size > 0;
    const { context } = inContext;
    const contextAvailable = Boolean(
      context &&
        (context.contextRenderableCount > 0 || context.environmentPresent)
    );
    const report = {
      artifacts: {
        contactSheet,
        inContext: inContextArtifact,
        isolated: isolatedArtifact,
        manifest,
      },
      assessment: {
        decisionOwner: "agent" as const,
        reasons: [
          "The agent must compare the contextual and isolated artifacts; execution success is not contextual approval.",
        ],
        verdict: contextAvailable
          ? ("review-required" as const)
          : ("unjudgeable" as const),
      },
      command: "render-context-pair" as const,
      evidence: {
        claims: {
          context: contextAvailable
            ? ("judgeable" as const)
            : ("unjudgeable" as const),
        },
        reasons: contextAvailable
          ? []
          : ["No declared, scene, or environment context was visible."],
        status: contextAvailable
          ? ("judgeable" as const)
          : ("unjudgeable" as const),
      },
      execution: executionStatus(executionSucceeded),
      lifecycle: {
        browserLaunches: 1 as const,
        bundles: 1 as const,
        sceneInstances: 1 as const,
        views: 2 as const,
      },
      success: executionSucceeded,
      variants: { inContext, isolated },
      warnings: [
        ...new Set([
          ...(inContext.warnings ?? []),
          ...(isolated.warnings ?? []),
          ...(contextAvailable
            ? []
            : [
                "Context-pair evidence is unjudgeable because no context was available.",
              ]),
        ]),
      ],
    };
    await writeFile(manifest, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await browser.close();
  }
}
