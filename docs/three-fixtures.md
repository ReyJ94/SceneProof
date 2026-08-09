# Three.js fixture protocol

SceneProof fixtures make source state deterministic without inventing a generic
interaction language. The fixture owns the scene lifecycle and domain actions;
SceneProof owns selection, evidence, camera framing, and capture.

## Custom draw pipelines

A fixture that uses `EffectComposer`, multiple passes, or another real visual
owner can provide `draw`. SceneProof sizes the renderer and resolves the camera
first, then calls `draw` exactly once instead of calling `renderer.render`:

```ts
import { defineThreeFixture } from "sceneproof/three";

export const createScene = defineThreeFixture(() => ({
  scene,
  camera,
  renderer,
  draw({ viewport }) {
    composer.setSize(viewport.pixelWidth, viewport.pixelHeight);
    composer.render();
  },
}));
```

`viewport` includes the full logical size, logical region, output pixel size,
and pixel ratio. Draw errors fail the command; SceneProof never falls back to a
second render. Reports distinguish `pipeline.drawOwner` from
`pipeline.rendererOwner` and record tone mapping, exposure, and output color
space. The hook is used by ordinary renders, regions, timelines, Scout,
matrices, context pairs, delivery review, reference sets, and compatibility
sweeps.

## Inspector ownership and provenance

Prefer an existing application export when it already creates the real scene
and camera. When extra setup is needed, treat the adapter as repository tooling:

```text
<repository>/
  scripts/
    sceneproof/
      gallery.scene.ts
      fixtures/
        featured.json
        highlight-action.json
```

A reusable inspector belongs under the repository-root
`scripts/sceneproof/`, beside other browser and agent tooling. A disposable
probe belongs under `/tmp/sceneproof-inspectors/`. Neither belongs in
application `src`, a route, or a production bundle.

The inspector may:

- import the production scene owner unchanged;
- supply deterministic props, providers, assets, viewport, and time;
- expose semantic targets around the real returned objects;
- translate a named fixture action into the real domain action;
- clean up resources that it created.

It must not copy or approximate production geometry, camera values,
layout, or state merely to make inspection run. Such a reconstruction tests the
inspector, not the application.

Keep two provenance claims separate:

1. **Source provenance:** the entry imported the current production owner.
2. **State provenance:** the props, action input, time, assets, and external data
   identify the state that was actually rendered.

SceneProof reports fixture paths and digests, but a deterministic fixture is not
automatically a capture of the live application. Claim live parity only when
the state was exported from the same application boundary and its freshness is
known. If the real behavior cannot be represented without reimplementing it,
report the visual check as blocked.

## Result contract

Visual commands default to a compact agent briefing with distinct layers:

- `execution.status` says only whether the command ran and wrote its artifacts;
- `artifacts` identifies what the agent should open;
- `provenance` identifies source, fixture state, aliases, CSS, and manifests;
- `facts` contains structure and measurements without turning them into taste;
- `assertions` contains only explicitly requested mechanical checks;
- `warnings` names concrete limitations such as missing context or software
  rasterization;
- `review` keeps `decisionOwner: "agent"` and says to open the artifact before
  making a visual claim.

Use `--json` for the complete factual report. Neither form awards an automatic
visual pass from luminance spread, a scalar similarity score, or command
success. Low contrast, weak framing, uncertain subject extraction, or absent
context remain useful facts and warnings; the CLI does not possess a model and
does not manufacture a universal verdict from them.

## Minimal factory

Any named export may be used. The return contract, not the export name, selects
the Three.js renderer.

```ts
import {
  defineThreeFixture,
  type ThreeFixtureContext,
} from "sceneproof/three";

import { createGalleryScene } from "../../src/gallery/create-gallery-scene";

type Props = {
  selectedId?: string;
};

export const createGalleryEvidence = defineThreeFixture(
  async (context: ThreeFixtureContext<Props>) => createGalleryScene(context)
);
```

`context.props` receives the JSON object supplied through `--props`. Missing
files and non-object JSON fail before Chromium starts. Reports retain the
absolute props path and SHA-256 digest so evidence can be reproduced.
If the production owner needs a different input shape, adapt those inputs; do
not recreate its visual output.

## Lifecycle contract

The full optional result surface is:

```ts
{
  scene,
  camera,
  renderer,
  ready,
  actions,
  seek,
  settle,
  targets,
  dispose,
}
```

- `ready`: awaited after factory creation and before inspection.
- `actions[name](input)`: fixture-owned deterministic domain action.
- `seek(timeMs)`: samples the same scene lifecycle at an exact time.
- `settle()`: advances the same lifecycle to its fixture-defined stable end.
- `targets`: logical selection boundaries independent of draw ownership.
- `dispose()`: releases fixture-owned renderers, controls, geometry, or other
  resources.

`renderer` may be a Three.js `WebGLRenderer` or `WebGPURenderer`. Prefer
omitting it unless the production owner must configure the renderer itself;
SceneProof then creates the renderer matching `--three-backend`. Returning a
renderer from the opposite family is an explicit error rather than a fallback.

For a normal command, SceneProof awaits `ready`, applies `--action` once, then
applies `--time`. `--action-input` must be a JSON object and requires an action.

For `--frames before,0,80,settled`, SceneProof creates one browser, one bundle,
and one scene. `before` is captured before the action; the action is applied
once before the first timed or settled frame.

## Semantic targets

Use fixture targets when one logical item is not represented by one
`Object3D`:

```ts
return {
  camera,
  scene,
  targets: [
    {
      id: "featured-item",
      label: "Featured item",
      members: [{ object: shell }, { object: nucleus }],
      context: [{ object: gallery }, { object: guideCurves }],
      bounds: () => new Box3().setFromObject(itemGroup),
      focus: () => itemGroup.getWorldPosition(new Vector3()),
      isolate: () => {
        // Optional fixture-owned isolation for shaders or batched draw owners.
      },
    },
  ],
};
```

The resulting CLI target is `three:featured-item`. IDs are normalized and
stable across commands.

`context` declares the surrounding renderables needed to judge the target in
its real perceptual environment. It does not change target bounds or ownership.
Use `render --context-pair` to produce in-context and isolated views in one
browser, bundle, and scene instance. `--in-context` and
`--isolated`/`--isolate` request either view individually. Isolation retains
all `Light` instances; it removes unrelated visible geometry, not illumination.

For ordinary `InstancedMesh` data, assign one ID per active instance:

```ts
mesh.userData.sceneproofInstanceIds = nodeIds;
```

SceneProof derives each instance's exact world bounds from its geometry bounding
box, instance matrix, and mesh world matrix. This makes the instance frameable
without rebuilding one scene per item. If exact visual isolation requires
shader or buffer changes, expose an explicit target with `isolate`.

## Camera semantics

Rendering has three independent controls:

- `--view original|front|side|top|isometric|azimuth,elevation` chooses the
  camera orientation source.
- `--framing source|fit|fill` chooses whether the source camera remains literal
  or is reframed around the target.
- `--projection source|perspective|orthographic` preserves or explicitly
  converts the evidence projection.

`--view original --framing source --projection source` clones the fixture
camera without changing its transform or projection. Reports include both
`camera.source` and `camera.resolved` plus `camera.modified` and
`camera.projection`. Projection conversion requires `fit` or `fill`; it is not
allowed to masquerade as literal source framing.

`fit` contains the target with margin. `fill` moves closer and permits
controlled clipping for detail inspection. `--scale` changes raster density;
it does not move the camera and cannot recover information absent from the
frame. Orthographic framing fits the target's projected corners rather than its
world-space bounding sphere. This matters for front, side, and top blueprints:
extent along the view axis must not make the visible form artificially small.

`--delivery-scale <pixels>` explicitly checks the logical on-screen target height at the
resolved camera. The default tolerance is 5%; override it with
`--delivery-tolerance <fraction>`. A miss does not mean rendering failed:
execution succeeds while the requested mechanical assertion fails. Visual
acceptance remains separate.

`--delivery-review <pixels>` is the safer aggregate for a shipping-size claim.
It requires literal source framing, projection, and fixture camera. The first
panel measures that ordinary delivery view; the second is a fresh fitted detail
render from the same state and draw pipeline. An assertion miss leaves all
artifacts intact and does not turn successful execution into a process failure.

## Scout evidence portfolio

Scout returns four intent-specific, copy-ready suggestions:

- `context`: the literal source-camera view;
- `sourceDetail`: a fresh rerender of the target's padded projected region
  while preserving source composition;
- `detail`: a close target-camera view selected primarily by target visibility;
- `shape`: an alternate view selected for useful edge and contrast evidence.

The report includes `diagnosis.limitingFactor`. When the target occupies little
of the frame, that measurement supports trying a tighter framing before merely
increasing raster scale. Open the contact sheet and judge the alternatives;
candidate scores narrow inspection but do not replace visual judgment.

Scout and render reports also expose coverage and luminance measurements. These
can warn an agent that evidence may be weak, but SceneProof does not convert a
global luminance threshold into a visual-quality verdict.

## Reference, comparison, and sweep evidence

Use `--reference` when a supplied raster is the design constraint. Automatic
subject extraction withholds numeric claims when confidence is low. Constrain
it with `--reference-region`, repeatable normalized
`--reference-foreground-seed x,y` and `--reference-background-seed x,y`, or an
exact same-sized `--reference-mask`. SceneProof always persists the candidate
mask and a cyan overlay; automatic, assisted, and explicit masks all remain
`needs-review` because extraction confidence is not semantic correctness. The
report keeps:

- aligned silhouette IoU, aspect ratio, widest-point height, and tip angle;
- fitted-spline silhouette deviation, curvature sign changes, and
  high-frequency direction reversals for edge-quality evidence;
- paired subject luminance p10, p50, p90, and maximum;
- repeatable normalized subject-space `--probe x,y` samples and local
  same-colour run widths;
- unaligned viewport composition center and size deltas;
- 101 normalized height samples with current/reference left edge, right edge,
  width, signed deltas, RMSE, maximum error, and contiguous too-wide/too-narrow
  intervals;
- mask component count, border-contact fraction, method, seeds, confidence
  meaning, verification state, and generated mask artifacts;
- reference, mask, region, and generated-artifact provenance.

Use `sceneproof matrix` for new parameter studies. Its manifest accepts two to
twelve labeled variants, each with a nested `props` delta, and writes individual
renders plus one contact sheet and adjacent raster comparisons:

```bash
sceneproof matrix scene.ts three:subject \
  --props fixtures/base.json \
  --variants fixtures/variants.json \
  --out artifacts/subject-matrix
```

SceneProof does not rank a visual winner. It reports the labeled states and
measured differences; the agent reads the sheet. Three.js matrices currently
vary fixture props; React matrices may also declare a checksum-guarded exact
`sourceOverlays` replacement for a sealed module constant. The overlay is
applied only in memory, must match one location, and never edits production
source. The older scalar `--sweep` and `--sweep-objective` flags remain
compatibility-only.

For genuinely different supplied perspectives, use `--reference-set` with a
JSON manifest containing two to eight labeled entries. Each entry may declare
`view`, `projection`, `framing`, `zoom`, `path`, `maskPath`, `region`,
`foregroundSeeds`, `backgroundSeeds`, and `probes`. Relative paths resolve from
the manifest. SceneProof uses one browser and one bundle, creates one
attributable scene per view, reports each comparison separately, identifies the
weakest measured view, and writes one unified contact sheet. The agent inspects
the per-view evidence; an aggregate does not erase a missing or low-confidence
perspective.

Comma-separated frame sequences are sparse checkpoints and retain an amplified
difference panel for each adjacent pair. `start..end@stepms` is continuous
motion evidence: the end is always included, ranges cap at 180 frames, and the
result contains saved PNG frames, a lossless APNG, up to 12 representative
contact-sheet frames, one aggregate motion map, and the JSON report. All raster
metrics are decoded from the saved PNG bytes rather than the transient canvas.
`render-region --frames` follows the same contract.

Add `--frames` to a Three.js `matrix` to place variants in rows and
representative times in columns. Continuous matrices cap raw work at 240 frames
across variants and emit one APNG per variant. Reports keep within-variant
motion separate from same-time variant comparisons and never select a winner.

## Execution diagnostics

SceneProof requires local Chromium and at least one supported graphics backend.
WebGL is the default; WebGPU is opt-in and strict:

```bash
sceneproof render scene.ts three:subject --three-backend webgpu --out subject.png
sceneproof doctor --require-backend both
```

`doctor` also reports the invoked path, resolved entry, effective version, Bun
global package manifest/version, and all PATH candidates. Installed-bin version
drift fails readiness with one reinstall command; a deliberately run source
checkout warns without being treated as a broken installation. Installation
findings remain available even when Chromium cannot launch.

When WebGPU is requested, SceneProof bundles the entry's bare `three` import
against `three/webgpu`, initializes `WebGPURenderer`, and verifies the actual
backend after initialization. A silent Three.js fallback to WebGL2 fails the
command. Visible `ShaderMaterial`, `RawShaderMaterial`, custom
`onBeforeCompile`, or dependencies that require WebGL-only Three.js exports
also fail with attributable compatibility guidance. Migrate those paths to
TSL/NodeMaterial and WebGPU-compatible addons, or choose WebGL explicitly.

Reports preserve requested and actual backend, renderer family, adapter data,
fallback status, and rasterizer. A SwiftShader or fallback-adapter result is
valid visual evidence when its quality gates pass, but it is not evidence of
hardware-GPU performance. `doctor` requires a real WebGPU clear-and-readback,
not just `navigator.gpu` or an adapter object. On Linux, SceneProof selects
Chromium's SwiftShader adapter for deterministic headless capture and reads the
GPU texture directly rather than relying on the transient presentation canvas.

In an agent sandbox, invoke SceneProof as the direct command with
unsandboxed/local-render permission:

```bash
sceneproof doctor
```

Do not bury the invocation in a pipe or compound shell when requesting that
permission. `doctor` exits non-zero if Chromium cannot launch or its requested
backend requirement is not met. Without `--require-backend`, either available
backend satisfies the graphics capability check.
