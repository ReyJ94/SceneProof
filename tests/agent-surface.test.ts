import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createAgentBriefing,
  createFullAgentReport,
} from "../src/agent-report.js";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "src/cli.ts");
const reactEntry = resolve(root, "tests/fixtures/DemoCard.tsx");
const darkThreeEntry = resolve(root, "tests/fixtures/DarkContrastScene.ts");
const advancedThreeEntry = resolve(root, "tests/fixtures/AdvancedScene.ts");
const aliasedThreeEntry = resolve(root, "tests/fixtures/AliasedThreeScene.ts");
const aliasedThreeStub = resolve(root, "tests/fixtures/three-accent-stub.ts");
const contextualEntry = resolve(root, "tests/fixtures/ContextualCard.tsx");
const contextualAuthStub = resolve(
  root,
  "tests/fixtures/contextual-auth-stub.tsx"
);
const externalCssEntry = resolve(root, "tests/fixtures/ExternalCssCard.tsx");
const externalCssA = resolve(root, "tests/fixtures/styles/a/entry.css");
const externalCssB = resolve(root, "tests/fixtures/styles/b/entry.css");
const profileEntry = resolve(root, "tests/fixtures/ProfileCard.tsx");
const profileBase = resolve(root, "tests/fixtures/profile-base.json");
const profileVariants = resolve(root, "tests/fixtures/profile-variants.json");
const typedPropsEntry = resolve(root, "tests/fixtures/TypedPropsPanel.tsx");
const processDependentEntry = resolve(
  root,
  "tests/fixtures/ProcessDependentCard.tsx"
);
const sealedProfileEntry = resolve(
  root,
  "tests/fixtures/SealedProfileCard.tsx"
);
const DUPLICATE_SHEET_LABEL = /duplicate contact-sheet label/i;
const INVALID_SHEET_ITEM = /--item requires label=path/i;
const SHEET_INPUT_OVERWRITE = /must not overwrite an input image/i;
const ALIAS_OPTION = /--alias/;

function runAgentCli(args: readonly string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      UISCENE_CHROME_PATH:
        process.env.UISCENE_CHROME_PATH ?? "/usr/bin/google-chrome",
    },
  });
}

test("ordinary renders expose facts and a restrained agent-owned review instead of visual verdicts", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-agent-report-"));
  try {
    const result = runAgentCli([
      "render",
      reactEntry,
      "dom:demo-card",
      "--export",
      "DemoCard",
      "--out",
      join(directory, "card.png"),
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "render");
    assert.equal(report.execution.status, "succeeded");
    assert.equal(report.artifacts.primary.kind, "render");
    assert.equal(report.facts.target.id, "dom:demo-card");
    assert.equal(report.review.required, true);
    assert.equal(report.review.decisionOwner, "agent");
    assert.equal(
      report.review.message,
      "Open the artifact before making a visual claim."
    );
    assert.equal("assessment" in report, false);
    assert.equal("evidence" in report, false);
    assert.equal("success" in report, false);
    assert.equal("questions" in report.review, false);
    assert.equal("nextActions" in report, false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("dark Three.js renders report luminance as a fact without forbidding agent judgment", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-agent-dark-"));
  try {
    const result = runAgentCli([
      "render",
      darkThreeEntry,
      "three:subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--stats",
      "--out",
      join(directory, "dark.png"),
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.review.required, true);
    assert.equal(report.review.decisionOwner, "agent");
    assert.equal(typeof report.facts.raster.surfaceLuminanceSpread, "number");
    assert.equal("judgeable" in report.facts.raster, false);
    assert.equal(result.stdout.toLowerCase().includes("unjudgeable"), false);
    assert.equal(
      result.stdout.toLowerCase().includes("visual-quality verdict requires"),
      false
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("React fixtures own wrapper and document context while aliases remain explicit provenance", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-agent-context-"));
  try {
    const common = [
      contextualEntry,
      "--export",
      "contextualCardFixture",
      "--renderer",
      "react",
      "--alias",
      `sceneproof-test-auth=${contextualAuthStub}`,
    ];
    const detailResult = runAgentCli([
      "node",
      contextualEntry,
      "dom:contextual-card",
      ...common.slice(1),
    ]);
    assert.equal(detailResult.status, 0, detailResult.stderr);
    const detail = JSON.parse(detailResult.stdout);
    assert.equal(detail.node.styles.backgroundColor, "rgb(10, 20, 30)");
    assert.deepEqual(detail.mount.document.html.classes, ["dark"]);
    assert.equal(detail.mount.fixture, true);
    assert.equal(
      detail.mount.aliases["sceneproof-test-auth"],
      contextualAuthStub
    );

    const renderResult = runAgentCli([
      "render",
      contextualEntry,
      "dom:contextual-card",
      ...common.slice(1),
      "--out",
      join(directory, "contextual-card.png"),
    ]);
    assert.equal(renderResult.status, 0, renderResult.stderr);
    const report = JSON.parse(renderResult.stdout);
    assert.deepEqual(report.provenance.document.html.classes, ["dark"]);
    assert.equal(
      report.provenance.aliases["sceneproof-test-auth"],
      contextualAuthStub
    );
    assert.equal(report.provenance.fixture, true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Three.js rendering carries explicit aliases through the actual source bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-three-alias-"));
  try {
    const result = runAgentCli([
      "render",
      aliasedThreeEntry,
      "three:alias-subject",
      "--export",
      "createScene",
      "--alias",
      `sceneproof-test-three-accent=${aliasedThreeStub}`,
      "--out",
      join(directory, "aliased.png"),
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.execution.status, "succeeded");
    assert.equal(existsSync(report.artifacts.primary.path), true);
    assert.equal(
      report.provenance.aliases["sceneproof-test-three-accent"],
      aliasedThreeStub
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}, 20_000);

test("Three.js Scout keeps aliases in every copy-ready follow-up command", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-scout-alias-"));
  try {
    const result = runAgentCli([
      "scout",
      aliasedThreeEntry,
      "three:alias-subject",
      "--export",
      "createScene",
      "--alias",
      `sceneproof-test-three-accent=${aliasedThreeStub}`,
      "--out",
      directory,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const commands = report.suggestions.map(
      (suggestion: { command: string }) => suggestion.command
    );
    assert.ok(commands.length > 0);
    for (const command of commands) {
      assert.match(command, ALIAS_OPTION);
      assert.ok(
        command.includes(`sceneproof-test-three-accent=${aliasedThreeStub}`)
      );
    }
    assert.equal(
      report.provenance.aliases["sceneproof-test-three-accent"],
      aliasedThreeStub
    );
    assert.equal(existsSync(report.artifacts.related.report.path), true);

    const fullResult = runAgentCli([
      "--json",
      "scout",
      aliasedThreeEntry,
      "three:alias-subject",
      "--export",
      "createScene",
      "--alias",
      `sceneproof-test-three-accent=${aliasedThreeStub}`,
      "--out",
      directory,
    ]);
    assert.equal(fullResult.status, 0, fullResult.stderr);
    const fullReport = JSON.parse(fullResult.stdout);
    assert.ok(fullReport.candidates.length > 3);
    assert.equal("assessment" in fullReport, false);
    assert.equal("evidence" in fullReport, false);
    assert.equal("success" in fullReport, false);
    assert.equal(fullReport.review.decisionOwner, "agent");
    assert.equal(
      fullReport.provenance.aliases["sceneproof-test-three-accent"],
      aliasedThreeStub
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}, 40_000);

test("each explicit CSS entry resolves relative imports from its own directory", () => {
  const result = runAgentCli([
    "node",
    externalCssEntry,
    "dom:external-css-card",
    "--export",
    "ExternalCssCard",
    "--renderer",
    "react",
    "--css",
    externalCssA,
    "--css",
    externalCssB,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const detail = JSON.parse(result.stdout);
  assert.equal(detail.node.styles.color, "rgb(11, 22, 33)");
  assert.equal(detail.node.styles.backgroundColor, "rgb(44, 55, 66)");
});

test("matrix renders labeled multi-parameter React variants without choosing a winner", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-agent-matrix-"));
  try {
    const result = runAgentCli([
      "matrix",
      profileEntry,
      "dom:profile-card",
      "--export",
      "ProfileCard",
      "--renderer",
      "react",
      "--props",
      profileBase,
      "--variants",
      profileVariants,
      "--out",
      directory,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "matrix");
    assert.equal(report.facts.variants.length, 2);
    assert.deepEqual(
      report.facts.variants.map((variant: { label: string }) => variant.label),
      ["restrained", "expressive"]
    );
    assert.equal(report.facts.variants[1].props.profile.amplitude, 44);
    assert.equal(report.facts.comparisons[0].classification, "changed");
    assert.deepEqual(report.facts.lifecycle, {
      bundles: 1,
      renderBrowserLaunches: 1,
      variants: 2,
    });
    assert.equal(report.review.decisionOwner, "agent");
    assert.equal(existsSync(report.artifacts.primary.path), true);
    assert.equal("recommendation" in report, false);
    for (const prohibited of ["appearance", "balanced", "best", "winner"]) {
      assert.equal(result.stdout.toLowerCase().includes(prohibited), false);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("sheet packages labeled visual evidence with fingerprints and no implied verdict", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-agent-sheet-"));
  try {
    const source = join(directory, "source.png");
    const render = runAgentCli([
      "render",
      reactEntry,
      "dom:demo-card",
      "--export",
      "DemoCard",
      "--out",
      source,
    ]);
    assert.equal(render.status, 0, render.stderr);

    const result = runAgentCli([
      "sheet",
      "--item",
      `context=${source}`,
      "--item",
      `detail=${source}`,
      "--compare",
      "--out",
      join(directory, "evidence"),
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const digest = `sha256:${createHash("sha256")
      .update(readFileSync(source))
      .digest("hex")}`;
    assert.equal(report.command, "sheet");
    assert.equal(report.execution.status, "succeeded");
    assert.equal(report.artifacts.primary.kind, "contact-sheet");
    assert.equal(existsSync(report.artifacts.primary.path), true);
    assert.deepEqual(
      report.facts.items.map((item: { label: string }) => item.label),
      ["context", "detail"]
    );
    assert.equal(report.facts.items[0].digest, digest);
    assert.equal(report.facts.items[0].bytes > 0, true);
    assert.equal(report.facts.items[0].width > 0, true);
    assert.equal(report.facts.items[0].height > 0, true);
    assert.equal(report.facts.comparisons[0].classification, "identical");
    assert.equal(report.review.decisionOwner, "agent");
    assert.equal("assessment" in report, false);
    for (const prohibited of ["fidelity", "pass", "winner", "best"]) {
      assert.equal(result.stdout.toLowerCase().includes(prohibited), false);
    }

    const persisted = JSON.parse(
      readFileSync(join(directory, "evidence", "manifest.json"), "utf8")
    );
    assert.equal(persisted.command, "sheet");
    assert.equal(persisted.items[0].digest, digest);
    assert.equal(persisted.comparisons[0].classification, "identical");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("sheet requires attributable labels and leaves raster comparison opt-in", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "sceneproof-agent-sheet-input-")
  );
  try {
    const source = join(directory, "source.png");
    const render = runAgentCli([
      "render",
      reactEntry,
      "dom:demo-card",
      "--export",
      "DemoCard",
      "--out",
      source,
    ]);
    assert.equal(render.status, 0, render.stderr);

    const packaged = runAgentCli([
      "sheet",
      "--item",
      `whole=${source}`,
      "--item",
      `focus=${source}`,
      "--out",
      join(directory, "packaged"),
    ]);
    assert.equal(packaged.status, 0, packaged.stderr);
    const report = JSON.parse(packaged.stdout);
    assert.equal("comparisons" in report.facts, false);

    const malformed = runAgentCli([
      "sheet",
      "--item",
      source,
      "--item",
      `focus=${source}`,
      "--out",
      join(directory, "malformed"),
    ]);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, INVALID_SHEET_ITEM);

    const duplicate = runAgentCli([
      "sheet",
      "--item",
      `same=${source}`,
      "--item",
      `same=${source}`,
      "--out",
      join(directory, "duplicate"),
    ]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, DUPLICATE_SHEET_LABEL);

    const overwrite = runAgentCli([
      "sheet",
      "--item",
      `whole=${source}`,
      "--item",
      `focus=${source}`,
      "--out",
      source,
    ]);
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, SHEET_INPUT_OVERWRITE);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Three matrices share one lifecycle, merge base props, and persist the neutral report", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-three-matrix-"));
  const baseProps = join(directory, "base.json");
  const variants = join(directory, "variants.json");
  writeFileSync(
    baseProps,
    JSON.stringify({ nested: { preserved: true }, offset: -2 })
  );
  writeFileSync(
    variants,
    JSON.stringify({
      variants: [
        { label: "left", props: { offset: -4 } },
        { label: "right", props: { offset: 4 } },
      ],
    })
  );

  try {
    const result = runAgentCli([
      "matrix",
      advancedThreeEntry,
      "three:semantic-focus",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      baseProps,
      "--variants",
      variants,
      "--out",
      join(directory, "artifacts"),
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.facts.lifecycle, {
      bundles: 1,
      renderBrowserLaunches: 1,
      variants: 2,
    });
    assert.equal(report.facts.variants[0].props.nested.preserved, true);
    assert.equal(report.facts.variants[1].props.offset, 4);
    assert.equal(report.facts.comparisons[0].classification, "changed");
    for (const prohibited of ["best", "recommendation", "winner"]) {
      assert.equal(result.stdout.toLowerCase().includes(prohibited), false);
    }
    assert.equal(
      report.artifacts.primary.path.endsWith("contact-sheet.png"),
      true
    );

    const persisted = JSON.parse(
      readFileSync(join(directory, "artifacts", "manifest.json"), "utf8")
    );
    assert.equal(persisted.command, "matrix");
    assert.deepEqual(persisted.lifecycle, {
      bundles: 1,
      renderBrowserLaunches: 1,
      variants: 2,
    });
    assert.equal("recommendation" in persisted, false);
    assert.equal("sweep" in persisted, false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}, 15_000);

test("props prints the derived fixture to stdout when no output file is requested", () => {
  const result = runAgentCli([
    "props",
    typedPropsEntry,
    "--export",
    "TypedPropsPanel",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const props = JSON.parse(result.stdout);
  assert.equal(typeof props.title, "string");
  assert.equal(typeof props.model.menuStage, "string");
  assert.equal("artifact" in props, false);
});

test("agent help presents matrix rather than the deprecated scalar sweep surface", () => {
  const rootHelp = runAgentCli(["--help"]);
  const renderHelp = runAgentCli(["render", "--help"]);

  assert.equal(rootHelp.status, 0, rootHelp.stderr);
  assert.equal(renderHelp.status, 0, renderHelp.stderr);
  assert.equal(rootHelp.stdout.includes("matrix"), true);
  assert.equal(rootHelp.stdout.includes("sheet"), true);
  assert.equal(rootHelp.stdout.includes("rank useful"), false);
  assert.equal(renderHelp.stdout.includes("--sweep"), false);
  assert.equal(renderHelp.stdout.includes("--css <file>"), true);
  assert.equal(renderHelp.stdout.includes("repeatable"), true);
  assert.equal(
    renderHelp.stdout.includes("Three.js target and context:"),
    true
  );
  assert.equal(renderHelp.stdout.includes("Fixture and viewport:"), true);
  assert.equal(renderHelp.stdout.includes("Browser source:"), true);
  assert.equal(
    renderHelp.stdout.includes("Three.js framing and evidence:"),
    true
  );
  assert.equal(renderHelp.stdout.includes("Reference analysis:"), true);
});

test("browser bundles provide the minimal process environment expected by application dependencies", () => {
  const result = runAgentCli([
    "node",
    processDependentEntry,
    "dom:process-card",
    "--export",
    "ProcessDependentCard",
    "--renderer",
    "react",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).node.text, "browser");
});

test("Scout briefings preserve mechanically grounded camera choices without choosing for the agent", () => {
  const report = createAgentBriefing("scout", {
    artifacts: { contactSheet: "/tmp/scout/contact-sheet.png" },
    candidates: {
      omitted: 1,
      shown: [{ id: "detail-1", score: 0.8, targetCoverage: 0.5 }],
      total: 2,
    },
    diagnosis: {
      higherScaleWouldHelp: false,
      limitingFactor: "framing",
      sourceTargetPixelFraction: 0.02,
    },
    execution: { status: "succeeded" },
    recommendations: {
      context: {
        command: "sceneproof render scene.ts three:target --framing source",
        reason: ["Preserves the literal fixture camera."],
      },
      detail: {
        command: "sceneproof render scene.ts three:target --framing fit",
        reason: ["Places more target signal in frame."],
      },
    },
    target: { id: "three:target" },
  });

  assert.equal(
    (report.facts as { diagnosis: { limitingFactor: string } }).diagnosis
      .limitingFactor,
    "framing"
  );
  assert.equal(
    (report.facts as { candidates: { total: number } }).candidates.total,
    2
  );
  assert.deepEqual(
    (report.suggestions as Array<{ kind: string }>).map(
      (suggestion) => suggestion.kind
    ),
    ["context", "detail"]
  );
  assert.equal("recommended" in report, false);
});

test("full public reports remove legacy epistemic verdicts and bespoke review questions", () => {
  const report = createFullAgentReport({
    assessment: {
      decisionOwner: "agent",
      verdict: "unjudgeable",
    },
    evidence: { status: "unjudgeable" },
    execution: { status: "succeeded" },
    nextActions: [{ reason: "A visual-quality verdict requires a reference." }],
    quality: {
      surfaceJudgeable: false,
      surfaceLuminanceSpread: 0,
    },
    review: {
      questions: ["Does this arbitrary use-case-specific criterion pass?"],
      required: true,
    },
    success: true,
  }) as Record<string, unknown>;

  const serialized = JSON.stringify(report);
  assert.equal("assessment" in report, false);
  assert.equal("evidence" in report, false);
  assert.equal("success" in report, false);
  for (const prohibited of [
    "arbitrary",
    "unjudgeable",
    "visual-quality verdict",
  ]) {
    assert.equal(serialized.toLowerCase().includes(prohibited), false);
  }
  assert.equal(
    serialized.includes("Open the artifact before making a visual claim"),
    true
  );
});

test("matrix varies sealed source constants in memory without mutating the source file", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-source-matrix-"));
  const before = readFileSync(sealedProfileEntry, "utf8");
  const digest = `sha256:${createHash("sha256").update(before).digest("hex")}`;
  const manifest = join(directory, "variants.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      variants: [
        {
          label: "restrained",
          props: {},
          sourceOverlays: [
            {
              expectedDigest: digest,
              file: sealedProfileEntry,
              replacements: [
                {
                  from: "{ amplitude: 12, entryRatio: 0.18, waves: 2 }",
                  to: "{ amplitude: 8, entryRatio: 0.12, waves: 1 }",
                },
              ],
            },
          ],
        },
        {
          label: "expressive",
          props: {},
          sourceOverlays: [
            {
              expectedDigest: digest,
              file: sealedProfileEntry,
              replacements: [
                {
                  from: "{ amplitude: 12, entryRatio: 0.18, waves: 2 }",
                  to: "{ amplitude: 52, entryRatio: 0.34, waves: 6 }",
                },
              ],
            },
          ],
        },
      ],
    })
  );

  try {
    const result = runAgentCli([
      "matrix",
      sealedProfileEntry,
      "dom:sealed-profile-card",
      "--export",
      "SealedProfileCard",
      "--renderer",
      "react",
      "--variants",
      manifest,
      "--out",
      join(directory, "artifacts"),
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.facts.comparisons[0].classification, "changed");
    assert.equal(
      report.facts.variants[0].sourceOverlays[0].expectedDigest,
      digest
    );
    assert.equal(readFileSync(sealedProfileEntry, "utf8"), before);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
