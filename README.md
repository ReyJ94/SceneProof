<p align="center">
  <img
    src="docs/sceneproof-banner.png"
    alt="SceneProof — Give coding agents sight."
    width="100%"
  />
</p>

<p align="center">
  <strong>Source-grounded visual perception for coding agents.</strong><br />
  Inspect, focus, and verify UI and 3D work at full quality.
</p>

<p align="center">
  <a href="https://github.com/ReyJ94/SceneProof/releases/tag/v0.6.0"><img alt="Release v0.6.0" src="https://img.shields.io/badge/release-v0.6.0-E6A34D?style=flat-square" /></a>
</p>

SceneProof lets coding agents see the interfaces and Three.js scenes they
build. It reconstructs the real source, exposes the structure that explains the
render, and produces exactly the context or detail view needed for reliable
visual judgment.

Agents can recognize what they made, understand why it looks wrong, and ground
their final judgment in falsifiable visual evidence—instead of coding UI and 3D
blind.

**New in v0.6.0:** convert evidence cameras explicitly between perspective and
orthographic projection, audit seed-assisted reference masks before trusting
metrics, localize silhouette disagreement over 101 height samples, and keep
every supplied view visible in one non-substituting comparison sheet.

**New in v0.5.0:** render Three.js fixtures through explicit WebGL or WebGPU
backends, prove the actual backend and adapter in every report, and reject
silent WebGL fallback or incompatible GLSL-only material paths.

**New in v0.4.0:** distinguish execution from visual acceptance, derive typed
React prop fixtures, compare targets in context and isolation, assert delivery
scale, and expose amplified motion and fitted-silhouette evidence.

**New in v0.3.0:** compare renders with supplied references, measure silhouette
and luminance deltas, probe exact subject-relative pixels, bracket fixture
parameters in one sweep, and constrain 3D work from labeled reference views.

## Install

SceneProof requires [Bun](https://bun.com/docs/installation) 1.3.14 or newer
and a local Chrome or Chromium installation.

```bash
bun add --global github:ReyJ94/SceneProof
sceneproof --help
```

That is the complete installation. It installs SceneProof directly from this
repository, including its runtime dependencies and global `sceneproof` command.

<details>
<summary><strong>I do not have Bun yet</strong></summary>

On macOS or Linux:

```bash
curl -fsSL https://bun.com/install | bash
```

On Windows PowerShell:

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

Open a new terminal, confirm `bun --version`, then run the SceneProof install
command above.

</details>

<details>
<summary><strong><code>sceneproof: command not found</code></strong></summary>

Bun places global commands in `~/.bun/bin`. If that directory is not already on
your PATH, add these lines to `~/.zshrc` or `~/.bashrc`, then open a new
terminal:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

</details>

<details>
<summary><strong>Chrome is not detected</strong></summary>

Point SceneProof at the local executable:

```bash
export SCENEPROOF_CHROME_PATH="/path/to/chrome"
sceneproof doctor
```

</details>

<details>
<summary><strong>Chromium is blocked by an agent sandbox</strong></summary>

Run `sceneproof` as the direct command with the agent's
**unsandboxed/local-render permission**. Do not hide it inside a compound shell,
pipe, or wrapper: those can prevent Chromium from starting before SceneProof can
return its own diagnostic.

```bash
sceneproof doctor
```

`doctor` reports executable discovery, browser launch, WebGL availability, an
actual WebGPU clear-and-readback probe, the active renderer or adapter, and the
required execution guidance. Merely finding a WebGPU adapter is not counted as
readiness. Use `sceneproof doctor --require-backend both` when both paths are a
release requirement. A failed requirement exits non-zero.

</details>

## The missing development loop

Coding agents are strong at reading source and changing it. Their visual
feedback remains weak.

Source code can prove that a component or mesh exists, but not that it is
legible, well-composed, correctly lit, or even visible. A screenshot shows
pixels, but loses hierarchy, material state, geometry, and ownership. Enlarging
that screenshot does not recover detail that was never rendered. A browser
harness can click through an application, but interaction is not visual
understanding.

SceneProof closes the loop:

1. **Map** the real UI or scene into stable semantic targets.
2. **Inspect** the exact structure behind the uncertain result.
3. **Frame** the relevant component, region, object, or world-space patch so it
   occupies an informative part of the image.
4. **Render** fresh evidence from source at the quality the remaining judgment
   requires.
5. **Verify** the artifact instead of inferring visual quality from plausible
   code.

Camera and region selection come before pixel density. More pixels help only
when the image already presents the evidence that matters.

## Evidence model

| Need | SceneProof evidence |
| --- | --- |
| Find the relevant thing | Compact React and Three.js trees with deterministic IDs |
| Understand why it looks wrong | Bounds, styles, geometry, attribute ranges, materials, uniforms, lights, cameras, and relationships |
| See it in context | Fresh source-based context renders |
| Inspect small detail | Target or logical-region rerenders, not enlarged screenshots |
| Understand 3D form | Source, fitted, filled, or alternate camera views |
| Find useful evidence quickly | A one-lifecycle Scout portfolio for context, source detail, close detail, and shape |
| Compare an interaction | Deterministic before/time/settled frames from one bundle and one live scene |
| Compare an implementation revision | A same-size previous/current contact sheet and amplified difference map |
| Match a supplied reference | Auditable masks, localized silhouette profiles, paired luminance, pixel probes, unaligned composition, and required comparison review |
| Bracket a fixture parameter | One-variable contact sheets ranked by an explicit geometry, appearance, composition, or balanced objective |
| Constrain a 3D form from several views | A labeled reference manifest evaluated per camera in one browser and one bundle |
| Preserve model context | Compact briefings with lossless evidence available by path only when needed |

SceneProof keeps three accounts of every visual result:

- **Execution:** whether SceneProof completed the requested work and persisted
  the declared artifacts. The legacy top-level `success` field means only this.
- **Evidence:** which claims the artifact can actually support: `judgeable`,
  `partially-judgeable`, `unjudgeable`, or `not-requested`.
- **Assessment:** who owns the decision and its current verdict. Automated
  constraints such as motion or delivery scale may pass or fail directly;
  reference matching remains an agent-owned judgment.

A successful command is therefore not a successful design:

```json
{
  "success": true,
  "execution": { "status": "succeeded", "meaning": "command-execution-only" },
  "evidence": { "status": "judgeable" },
  "assessment": {
    "decisionOwner": "agent",
    "verdict": "review-required"
  }
}
```

When `--reference` is supplied, SceneProof aligns and measures the subjects and
produces a reference/current/difference contact sheet plus a silhouette overlay,
amplified difference map, candidate mask, and cyan mask overlay. It does not
turn a similarity score into a taste verdict. The agent must first verify that
the overlay selects the intended subject, then reconcile localized silhouette,
composition, luminance, and probe deltas with the intended claim. If subject
extraction or dynamic range is inadequate, the result is `unjudgeable`; the
agent must not claim a match.

Within that status contract, SceneProof preserves two complementary forms of
evidence:

- **Structural truth:** what the source produced—hierarchy, identity, bounds,
  transforms, styles, geometry, materials, lights, cameras, and visibility.
- **Perceptual truth:** what the result presents—composition, hierarchy,
  silhouette, depth, density, contrast, clipping, and small-scale detail.

The render exposes the visible result. When it is wrong, the structure often
reveals why. Neither replaces the other.

`inspect` and `scout` return compact, decision-oriented briefings. Warnings,
target identity, omission counts, provenance, and the next useful evidence stay
inline. Exact lossless JSON is written automatically and exposed through
`evidence.full.path`; the agent opens it only when an omitted fact can change
the decision.

Piped output is compact JSON for model efficiency. Interactive terminal output
remains formatted for humans.

Reference comparison deliberately keeps different claims separate. Aligned
silhouette evidence measures projected shape independent of placement;
`reference.composition` reports the original viewport center and size deltas;
paired histograms and repeatable `--probe x,y` samples measure appearance.
`--sweep-objective geometry|appearance|composition|balanced` chooses which of
those facts may rank a one-variable `--sweep`.

When independent perspectives are available, declare them instead of asking a
single hero image to prove unseen geometry:

```json
{
  "references": [
    { "label": "front", "view": "front", "projection": "orthographic", "path": "blueprint.png", "region": [40, 20, 600, 900], "foregroundSeeds": [[0.32, 0.48]], "backgroundSeeds": [[0.08, 0.12]] },
    { "label": "side", "view": "side", "projection": "orthographic", "path": "blueprint.png", "maskPath": "side-mask.png" }
  ]
}
```

```bash
sceneproof render scripts/sceneproof/monument.scene.ts three:monument \
  --reference-set references.json \
  --out artifacts/monument-reference-set
```

Each labeled view retains its own camera, projection, mask, artifacts, and
score. The unified sheet keeps every reference/current/difference row visible,
and the report names the worst analyzed view. The aggregate never substitutes
one perspective for another; one unjudgeable view keeps the multi-view verdict
unjudgeable.

## Agent-facing surface

| Verb | Purpose |
| --- | --- |
| `tree` | Navigate semantic structure |
| `node` | Inspect one exact target and its immediate relationships |
| `props` | Derive a typed JSON skeleton for a React component export |
| `inspect` | Reconstruct the source and preserve the canonical scene artifact |
| `scout` | Discover useful Three.js target cameras in one scene lifecycle |
| `render` | Produce fresh context or target evidence |
| `render-region` | Rerender an exact logical viewport patch |
| `doctor` | Prove Chromium and WebGL/WebGPU readiness and explain required permissions |

SceneProof owns renderer setup and evidence persistence. The agent chooses the
real source boundary, declared state, semantic target, framing, and evidence
needed to resolve the uncertainty.

## Inspecting application source

Use an existing product export whenever it already represents the real visual
boundary. If deterministic setup is needed:

- put a reusable repository-owned inspector in
  `scripts/sceneproof/<surface>.scene.ts`;
- put its state snapshots in `scripts/sceneproof/fixtures/`;
- put a disposable investigation under `/tmp/sceneproof-inspectors/`;
- never put SceneProof adapters, copied geometry, or invented state in
  application `src`.

An inspector may import the production owner unchanged, supply deterministic
props and providers, expose semantic targets, and translate a domain action
into the real scene lifecycle. It must not reconstruct how the application
“probably” looks. Source reconstruction proves the current code under the
declared fixture state; it does not prove parity with an unrecorded live browser
state.

If the real boundary cannot be loaded without manufacturing the behavior under
test, visual verification is blocked rather than approximated.

## React quick path

SceneProof accepts a named component export, deterministic JSON props, source
CSS, workspace aliases, and Tailwind v4 styles:

```bash
sceneproof tree src/components/DemoCard.tsx \
  --export DemoCard \
  --props fixtures/demo-card.json

sceneproof node src/components/DemoCard.tsx \
  dom:demo-card \
  --export DemoCard \
  --props fixtures/demo-card.json

sceneproof render src/components/DemoCard.tsx \
  dom:demo-card \
  --export DemoCard \
  --props fixtures/demo-card.json \
  --scale 4 \
  --out artifacts/demo-card.png
```

For a typed production component whose props are not yet available as a
fixture, derive the shape instead of reverse-engineering an intersection type
by hand:

```bash
sceneproof props src/PricingPanel.tsx \
  --export PricingPanel \
  --out scripts/sceneproof/fixtures/pricing-panel.json
```

`--partial-props` may then deep-complete a supplied partial object with explicit
typed placeholders. Reports list every synthesized and unsupported path, so a
placeholder cannot be mistaken for real application state:

```bash
sceneproof inspect src/PricingPanel.tsx \
  --export PricingPanel \
  --props partial-pricing-panel.json \
  --partial-props
```

Use `render-region` when the surrounding viewport coordinate system matters.
It performs a fresh render at the requested device scale; it does not crop and
enlarge an earlier PNG.

## Three.js quick path

A Three.js entry may use **any export name**. With `--renderer auto`, SceneProof
selects the requested export and detects Three.js from its `{ scene, camera }`
return contract. `--renderer three` is the deterministic escape hatch when a
factory has browser-specific setup. `defineThreeFixture` from
`sceneproof/three` brands a factory so auto detection does not need to invoke it
in the probe.

First inspect structure, then let Scout discover informative framing when the
useful camera is uncertain:

```bash
sceneproof node scripts/sceneproof/gallery.scene.ts \
  three:featured-item \
  --export createGalleryEvidence \
  --props scripts/sceneproof/fixtures/selected.json

sceneproof scout scripts/sceneproof/gallery.scene.ts \
  three:featured-item \
  --export createGalleryEvidence \
  --props scripts/sceneproof/fixtures/selected.json \
  --out artifacts/gallery-scout
```

`--view original --framing source --projection source` preserves the complete
source camera literally. `--projection perspective|orthographic` converts the
evidence camera when a supplied image requires a matching projection; conversion
uses `fit` or `fill` framing and is reported in `camera.projection`. Orthographic
fit uses the target's projected extent, so a top view is not reduced by height
that is invisible in that projection. `fit` contains the target. `fill`
prioritizes target visibility and allows controlled clipping for close
inspection. Scout provides four different evidence intentions:

- `context`: literal source composition;
- `sourceDetail`: a fresh source-camera region render;
- `detail`: a close view ranked for target visibility;
- `shape`: an alternate view ranked for form evidence.

Only increase `--scale` when those views already frame the relevant evidence
and raster detail is still limiting.

Fixture-owned actions and deterministic timeline sampling keep transient
evidence in one real scene lifecycle:

```bash
sceneproof render scripts/sceneproof/gallery.scene.ts \
  three:featured-item \
  --export createGalleryEvidence \
  --props scripts/sceneproof/fixtures/selected.json \
  --action select \
  --frames before,0,80,160,settled \
  --framing source \
  --out artifacts/select-transition.png
```

For a target whose fixture declares relevant surrounding objects, capture the
context and isolated form from the same live scene rather than approving a form
against an empty background:

```bash
sceneproof render scripts/sceneproof/gallery.scene.ts \
  three:featured-item \
  --export createGalleryEvidence \
  --context-pair \
  --delivery-scale 300 \
  --out artifacts/item-context-pair
```

The report states whether context was declared, the actual target height in
pixels, and whether it satisfied the requested delivery scale. `--in-context`
and `--isolated` select either view independently; `--isolated` is an alias for
`--isolate`, and isolation preserves lights.

For the exact lifecycle, semantic target, instance ID, camera, and diagnostic
contracts, read [the Three.js fixture protocol](docs/three-fixtures.md).

### WebGL and WebGPU

WebGL remains the compatibility-first default. Select WebGPU explicitly when
the source is WebGPU-compatible:

```bash
sceneproof render scripts/sceneproof/gallery.scene.ts \
  three:featured-item \
  --three-backend webgpu \
  --framing source \
  --out artifacts/gallery-webgpu.png
```

SceneProof reports `graphics.requested`, `renderer`, `actual`, `fallback`,
adapter identity, and rasterizer provenance. A WebGPU request is strict: if
Three.js falls back to WebGL2, the command fails instead of mislabeling the
artifact. WebGPU entries are bundled against `three/webgpu`; GLSL
`ShaderMaterial`, `RawShaderMaterial`, custom `onBeforeCompile`, and addons that
depend on WebGL-only Three.js exports are rejected with migration guidance.
Use TSL/NodeMaterial and WebGPU-compatible addons for that path, or request
`--three-backend webgl` deliberately.

WebGPU is not automatically faster or visually better. Headless Chromium may
expose a fallback adapter such as SwiftShader; those artifacts can prove
rendering and visual behavior, but they are not real-GPU performance evidence.
The report preserves that distinction rather than treating backend availability
as a quality verdict. On Linux, SceneProof selects Chromium's SwiftShader
WebGPU adapter for deterministic headless capture and reads the rendered GPU
texture directly because the presentation canvas is transient. Use the
reported backend and adapter as provenance, never as a performance claim.

## Current scope

SceneProof currently supports:

- TypeScript and JavaScript source entries;
- React DOM, computed styles, semantic text and roles, SVG subtrees, and
  logical-region rendering;
- workspace `@/` imports, JSON props, source CSS, and Tailwind v4;
- Three.js scene graphs, transforms, world bounds, BufferGeometry attributes,
  materials, shader uniforms, textures, lights, cameras, and relationships;
- explicit WebGL and WebGPU capture with backend, adapter, fallback, and
  rasterizer provenance; strict WebGPU compatibility checks prevent silent
  WebGL substitution or partial GLSL evidence;
- custom-named Three.js factories, deterministic props/actions/time, source
  camera preservation, semantic targets, stable `InstancedMesh` instance IDs,
  and single-lifecycle frame sequences;
- full-quality source rerendering, target-aware camera control, bounded source
  region rendering, information-gain Scout portfolios, and compact evidence
  briefings;
- reference/current/difference comparison, amplified adjacent-frame
  differences, seed-assisted and explicit mask audit artifacts, 101-row
  silhouette profile deltas, fitted-spline silhouette deviation,
  context/isolated pairs, and delivery-scale assertions;
- typed React prop skeletons and explicitly provenance-marked partial-prop
  completion.

SVG-native export is not implemented. The GitHub installation uses SceneProof's
linked source entry. The standalone Bun compiled binary remains experimental
for arbitrary workspace entries with nested package imports. WebGPU support is
bounded by the source's Three.js compatibility: SceneProof does not translate
GLSL shaders or WebGL-only addons into TSL.

## Development

<details>
<summary><strong>Work from source</strong></summary>

```bash
git clone https://github.com/ReyJ94/SceneProof.git
cd SceneProof
bun install --frozen-lockfile
bun run cli --help
```

</details>

<details>
<summary><strong>Local quality gate</strong></summary>

```bash
bun run check
```

The public gate runs lint, strict TypeScript 7 typechecking, the self-contained
browser-backed test harness, the Bun compiled build, and a compiled typed-props
smoke test.

</details>

See [the changelog](CHANGELOG.md) for release-level behavior changes.

## License

[MIT](LICENSE) © 2026 ReyJ94
