<p align="center">
  <img
    src="docs/sceneproof-banner.png"
    alt="SceneProof — Give coding agents sight."
    width="100%"
  />
</p>

<p align="center">
  <a href="https://github.com/ReyJ94/SceneProof/releases/tag/v0.7.0"><img alt="Release v0.7.0" src="https://img.shields.io/badge/release-v0.7.0-E6A34D?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-6B8E9E?style=flat-square" /></a>
</p>

SceneProof turns visual work into a loop an agent can actually run. It renders
your React components and Three.js scenes straight from source, then pairs the
image with the structure and context behind it. The agent can see what changed,
understand why, and keep working instead of guessing from code.

## Install

```bash
bun add --global github:ReyJ94/SceneProof
sceneproof --help
```

SceneProof needs [Bun](https://bun.com/docs/installation) 1.3.14+ and a local
Chrome or Chromium. If setup gets fussy, jump to
[troubleshooting](#troubleshooting).

SceneProof also ships with a [`SKILL.md`](skills/sceneproof/SKILL.md) for any
agentic harness that supports skills.

## Try it

```bash
sceneproof render src/components/DemoCard.tsx \
  dom:demo-card \
  --export DemoCard \
  --props fixtures/demo-card.json \
  --scale 4 \
  --out artifacts/demo-card.png
```

Swap in your own component and props file. SceneProof renders it fresh from
source at the scale you asked for—not as a crop of an old screenshot. From
there, [`tree`](#the-workflow) shows the structure, [`scout`](#threejs-quick-path)
helps with Three.js cameras, and the [React](#react-quick-path) and
[Three.js](#threejs-quick-path) guides cover the rest.

## Why agents use it

- **You can trace the picture back to the code.** React and Three.js trees keep
  stable IDs, bounds, styles, materials, lights, and cameras alongside the
  render.
- **You fix the view before buying more pixels.** Context renders, fresh region
  renders, and Scout camera candidates make framing problems obvious.
- **You get facts, not a made-up verdict.** SceneProof reports what ran, what it
  rendered, how it got there, and what it measured. The agent still judges the
  result.
- **References stay auditable.** Silhouette, luminance, and pixel-probe deltas
  come with the mask and overlays needed to check that SceneProof compared the
  right subject.
- **Different kinds of evidence can still travel together.** A labeled sheet can
  hold a context render, a focused detail, a reference, and a before frame
  without pretending they are one kind of test.
- **The graphics backend is never a mystery.** Every Three.js render names the
  WebGL or WebGPU path and adapter it actually used. WebGPU fails loudly rather
  than quietly falling back.

## What's new in v0.7.0

This release makes React inspection feel like part of the app instead of a
special case. Fixtures can bring their own wrappers, providers, document
context, CSS, and explicit module aliases without changing production APIs.
Matrices compare several labeled states at once; `sheet` collects evidence from
different commands into one artifact. Reports now stick to provenance, facts,
warnings, and explicit checks. The agent still makes the visual call.

<details>
<summary>Earlier releases</summary>

**v0.6.0** — Added explicit perspective and orthographic evidence cameras,
auditable seed-assisted masks, localized silhouette differences, and one sheet
that keeps every supplied reference view visible.

**v0.5.0** — Added explicit WebGL and WebGPU rendering, backend and adapter
reporting, and clear failures for silent fallback or incompatible GLSL-only
materials.

**v0.4.0** — Separated execution from visual acceptance, added typed React prop
fixtures, context pairs, delivery-scale checks, motion evidence, and fitted
silhouettes.

**v0.3.0** — Added supplied-reference comparison, silhouette and luminance
deltas, exact pixel probes, scalar sweeps, and labeled 3D reference views.

</details>

## The workflow

| Verb | Purpose |
| --- | --- |
| `tree` | See the semantic structure |
| `node` | Inspect one target and its immediate relationships |
| `props` | Derive a typed JSON starting point for React props |
| `matrix` | Put labeled variants into one contact sheet |
| `sheet` | Collect labeled PNG evidence from any workflow |
| `inspect` | Rebuild the source and save the full scene artifact |
| `scout` | Compare useful Three.js camera candidates |
| `render` | Render a target or its context fresh from source |
| `render-region` | Rerender one exact viewport patch |
| `doctor` | Check Chromium, WebGL, WebGPU, and local permissions |

SceneProof handles the renderer and saves the evidence. The agent chooses the
real source, state, target, and view that matter for the job.

## React quick path

Point any command at a named export and give it deterministic JSON props.
SceneProof picks up source CSS, workspace `@/` aliases, and Tailwind v4 too:

```bash
sceneproof tree src/components/DemoCard.tsx --export DemoCard --props fixtures/demo-card.json
sceneproof node src/components/DemoCard.tsx dom:demo-card --export DemoCard --props fixtures/demo-card.json
sceneproof render src/components/DemoCard.tsx dom:demo-card --export DemoCard --props fixtures/demo-card.json --scale 4 --out artifacts/demo-card.png
```

Don't have props for a typed production component yet? Let SceneProof sketch
the JSON instead of reverse-engineering the type by hand:

```bash
sceneproof props src/PricingPanel.tsx --export PricingPanel --out fixtures/pricing-panel.json
```

`--partial-props` fills the missing paths with clearly labeled placeholders.
The report tells you exactly what it synthesized, so those values can't be
mistaken for real state. `render-region` renders a fresh viewport patch at
device scale instead of cropping an existing image.

If the component needs providers, wrapper markup, or an ancestor theme class,
put that setup in a fixture instead of changing the production component:

```tsx
import { defineReactFixture } from "sceneproof/react";
import { AccountPanel } from "@/components/account-panel";
import { AppShell } from "@/components/app-shell";

export const accountPanelFixture = defineReactFixture({
  document: { html: { classes: ["dark"] } },
  render: (props) => (
    <AppShell
      canvas={<PreviewFixture />}
      composer={<ContentFixture />}
      sidebar={<AccountPanel {...props} />}
    />
  ),
});
```

If an integration doesn't belong in a browser bundle, alias it to an explicit
local stub. SceneProof records every substitution without touching application
source:

```bash
sceneproof render scripts/sceneproof/account-panel.scene.tsx dom:account-panel \
  --export accountPanelFixture \
  --alias @auth/server=./scripts/sceneproof/auth-stub.ts \
  --css src/styles/globals.css \
  --css src/styles/app-shell.css \
  --out artifacts/account-panel.png
```

Each stylesheet resolves relative imports from its own directory. Repeat
`--css` in the order you want the cascade applied.

Use a matrix when you want to compare whole states side by side instead of
squeezing the design into one scalar sweep:

```bash
sceneproof matrix scripts/sceneproof/account-panel.scene.tsx dom:account-panel \
  --variants scripts/sceneproof/fixtures/account-panel-variants.json \
  --out artifacts/account-panel-matrix
```

Each variant can change several nested props together. If the React value is a
sealed module constant, the manifest can use a checksum-guarded
`sourceOverlays` replacement instead. SceneProof applies it only inside the
browser bundle, requires one exact match, records it in provenance, and never
writes it back to the worktree. Three.js matrices currently vary fixture props
only. The older scalar `--sweep` flags still work for compatibility, but they
stay out of the main help surface.

Sometimes the useful evidence doesn't belong to one matrix: the whole sidebar,
a fresh 4× boundary render, the earlier version, and a supplied reference. Put
those artifacts into one labeled sheet instead of opening them from memory:

```bash
sceneproof sheet \
  --item context=artifacts/account-panel.png \
  --item boundary@4x=artifacts/account-panel-detail.png \
  --item before=artifacts/account-panel-before.png \
  --item reference=references/account-panel.png \
  --out artifacts/account-panel-review
```

`sheet` doesn't rerender, choose a camera, or rank the images. It records the
path, dimensions, byte size, and SHA-256 of every input, then packages them in
the order you gave it. Use `matrix` for source variants and `scout` for Three.js
camera discovery. Add `--compare` only when adjacent frames are actually
comparable; a pixel delta between a context shot and a detail shot is just
noise.

## Three.js quick path

The factory can have any export name. `--renderer auto` recognizes Three.js by
its `{ scene, camera }` return value, or you can mark it explicitly with
`defineThreeFixture` from `sceneproof/three`. Start with structure. If the right
camera isn't obvious, let Scout lay out the useful candidates:

```bash
sceneproof node scene.ts three:featured-item --export createGalleryEvidence --props fixtures/selected.json
sceneproof scout scene.ts three:featured-item --export createGalleryEvidence --props fixtures/selected.json --out artifacts/gallery-scout
```

Scout returns four useful views: `context` keeps the source composition,
`sourceDetail` rerenders a region fresh from source, `detail` gets close to the
target, and `shape` tries another angle. Fix the framing first. Raise `--scale`
only when the view is already useful and raster detail is the remaining limit.

When a supplied reference calls for another projection, use
`--projection perspective|orthographic`. `fit` keeps the target inside the
frame; `fill` moves in and allows controlled clipping. Actions and timeline
frames stay inside one real scene lifecycle:

```bash
sceneproof render scene.ts three:featured-item --export createGalleryEvidence --props fixtures/selected.json \
  --action select --frames before,0,80,160,settled --framing source --out artifacts/select-transition.png
```

`--context-pair` captures the target alone and in its surrounding scene without
rebuilding the fixture. That makes it harder to approve a form against an empty
background it will never ship with. The
[Three.js fixture protocol](docs/three-fixtures.md) covers lifecycle details,
instance IDs, and deeper diagnostics.

WebGL is the default. Request WebGPU explicitly with `--three-backend webgpu`
when the source supports it. SceneProof reports the backend and adapter it
actually used, and fails rather than quietly falling back to WebGL2. See
[Execution diagnostics](docs/three-fixtures.md#execution-diagnostics) for the
compatibility details.

## How SceneProof reports a result

SceneProof isn't a model, and it doesn't know what “good” means for your task.
Its report sticks to what the harness can actually establish:

- **Execution** tells you whether the command finished.
- **Artifacts** tells you what to open.
- **Provenance** tracks the source, fixture state, CSS, document context,
  aliases, and in-memory source overlays behind the result.
- **Facts and warnings** cover things SceneProof can measure or observe: bounds,
  coverage, cameras, renderers, pixels, motion, comparisons, and limitations.
- **Assertions** pass or fail only when you explicitly ask for a mechanical
  check such as delivery height or visible change.
- **Review** reminds the agent that the final visual call still requires looking
  at the artifact.

```json
{
  "execution": { "status": "succeeded", "meaning": "command-execution-only" },
  "artifacts": { "primary": { "kind": "render", "path": "/tmp/account-panel.png" } },
  "facts": { "target": { "id": "dom:account-panel" } },
  "review": {
    "required": true,
    "decisionOwner": "agent",
    "message": "Open the artifact before making a visual claim."
  }
}
```

The default output is short enough for an agent loop. Add `--json` when you want
the full factual report. SceneProof no longer exposes the old global
judgeability fields, automatic aesthetic ranking, preset review questions, or
automatic demands for a reference.

With `--reference`, SceneProof also writes an aligned silhouette overlay, an
amplified difference map, a candidate mask, paired luminance histograms, and
any repeatable `--probe x,y` samples you asked for. Check that the overlay sits
on the intended subject before trusting the numbers. A `--reference-set` keeps
several labeled views separate, with their own camera and mask, so an aggregate
can't hide a bad perspective.

## Keep fixtures honest

If the product already exports the real visual boundary, use it. When you need
deterministic setup, keep that setup outside application code:

- reusable inspectors in `scripts/sceneproof/<surface>.scene.ts`;
- fixture data in `scripts/sceneproof/fixtures/`;
- one-off investigations in `/tmp/sceneproof-inspectors/`.

An inspector can import the production owner unchanged and drive it with real
props and actions. It shouldn't copy geometry, invent state inside `src`, or
guess how the app probably looks. A fixture proves the current code under the
state you declared; it doesn't prove parity with a live session you never
recorded. If loading the real boundary would require faking the behavior under
test, stop there instead of building a convincing lookalike.

## What works today

SceneProof currently handles:

- TypeScript and JavaScript source entries;
- React DOM, computed styles, semantic roles, SVG subtrees, and fresh region
  renders;
- fixture-owned wrappers and document context, explicit module aliases,
  per-file CSS resolution, workspace `@/` imports, JSON props, and Tailwind v4;
- labeled multi-parameter matrices and guarded in-memory React source overlays;
- labeled cross-workflow evidence sheets with input-byte fingerprints and
  opt-in adjacent raster comparison;
- full Three.js scene graphs, including transforms, bounds, geometry,
  materials, uniforms, textures, lights, and cameras;
- explicit WebGL and WebGPU capture with strict compatibility checks;
- custom factory names, deterministic props, actions and time, plus stable
  `InstancedMesh` IDs;
- reference/current/difference evidence with silhouettes, luminance, pixel
  probes, and auditable masks;
- typed React prop skeletons, including clearly marked partial completion.

SVG-native export isn't here yet. The GitHub install runs SceneProof from its
linked source entry; the standalone compiled binary is still experimental for
workspace entries with nested imports. WebGPU also depends on the source's own
Three.js compatibility—SceneProof won't translate GLSL shaders or WebGL-only
addons into TSL for you.

## Troubleshooting

<details>
<summary><strong>Bun isn't installed</strong></summary>

On macOS or Linux:

```bash
curl -fsSL https://bun.com/install | bash
```

On Windows PowerShell:

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

Open a new terminal, check `bun --version`, then run the SceneProof install
command above.

</details>

<details>
<summary><strong><code>sceneproof</code> isn't on the PATH</strong></summary>

Bun puts global commands in `~/.bun/bin`. If that directory isn't already on
your PATH, add these lines to `~/.zshrc` or `~/.bashrc`, then open a new
terminal:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

</details>

<details>
<summary><strong>SceneProof can't find Chrome</strong></summary>

```bash
export SCENEPROOF_CHROME_PATH="/path/to/chrome"
sceneproof doctor
```

</details>

<details>
<summary><strong>An agent sandbox is blocking Chromium</strong></summary>

Run `sceneproof` directly with the agent's **unsandboxed/local-render
permission**. Avoid a compound shell or pipe; it can stop Chromium before
SceneProof gets a chance to report the failure.

```bash
sceneproof doctor
```

`doctor` checks the executable, browser launch, WebGL, a real WebGPU
clear-and-readback probe, and the active renderer and adapter. It exits non-zero
when a requirement fails. Add `--require-backend both` when you need both
graphics paths.

</details>

## Development

<details>
<summary><strong>Run it from source</strong></summary>

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

That runs lint, strict TypeScript 7 typechecking, the browser-backed tests, the
Bun compiled build, and a compiled typed-props smoke test.

</details>

See [the changelog](CHANGELOG.md) for release-level behavior changes.

## License

[MIT](LICENSE) © 2026 ReyJ94
