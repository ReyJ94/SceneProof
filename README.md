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

SceneProof lets coding agents see the interfaces and Three.js scenes they
build. It reconstructs the real source, exposes the structure that explains the
render, and produces exactly the context or detail view needed for reliable
visual judgment.

Agents can finally recognize what they made, understand why it looks wrong, and
prove that it is visually finished—instead of coding UI and 3D blind.

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
3. **Focus** the relevant component, region, object, or world-space patch.
4. **Render** fresh evidence from source at the perspective and quality the
   judgment requires.
5. **Verify** the artifact instead of inferring visual quality from plausible
   code.

## What SceneProof gives an agent

| Need | SceneProof evidence |
| --- | --- |
| Find the relevant thing | Compact React and Three.js trees with deterministic IDs |
| Understand why it looks wrong | Bounds, styles, geometry, attribute ranges, materials, uniforms, lights, cameras, and relationships |
| See it in context | Fresh source-based context renders |
| Inspect small detail | Target and logical-region rerenders at model-chosen quality |
| Understand 3D form | Named or exact perspectives, camera zoom, world-space focus, and isolation |
| Find a useful camera quickly | A one-scene Scout contact sheet with ranked front, side, top, isometric, and source-camera views |
| Preserve model context | Compact briefings with lossless evidence available by path only when needed |

This is not screenshot zoom. React detail is rerendered at a new device scale.
Three.js detail is rerendered through a new camera and WebGL render target.
SceneProof never enlarges an old PNG and calls it additional evidence.

## Structure and pixels belong together

SceneProof keeps two accounts of the result:

- **Structural truth:** what the source produced—hierarchy, identity, bounds,
  transforms, styles, geometry, materials, lights, cameras, and visibility.
- **Perceptual truth:** what the result presents—composition, hierarchy,
  silhouette, depth, density, contrast, clipping, and small-scale detail.

The render reveals that something is wrong. The structure often reveals why.
Neither replaces the other.

That distinction prevents common agent mistakes: treating a present node as a
visible one, treating pixel density as camera zoom, repairing a shader when the
camera is wrong, or brute-force supersampling geometry whose opacity is
structurally zero.

## Evidence without context pollution

SceneProof hides renderer and extraction machinery behind six stable verbs. It
does not force a coding agent to ingest every internal API shape.

`inspect` and `scout` return compact, decision-complete briefings. Warnings,
target identity, omission counts, provenance, and the next useful evidence stay
inline. Exact lossless JSON is written automatically and exposed through
`evidence.full.path`; the agent opens it only when an omitted fact can change
the decision.

Large geometry arrays, camera candidates, and complete structural reports remain
available without flooding the model's active context. SceneProof returns the
smallest useful briefing first and points to the preserved lossless evidence
when deeper inspection is warranted.

Piped output is compact JSON for model efficiency. Interactive terminal output
remains formatted for humans.

## Agent-facing surface

| Verb | Purpose |
| --- | --- |
| `tree` | Navigate semantic structure |
| `node` | Inspect one exact target and its immediate relationships |
| `inspect` | Reconstruct the source and preserve the canonical scene artifact |
| `scout` | Discover useful Three.js target cameras in one scene lifecycle |
| `render` | Produce fresh context or target evidence |
| `render-region` | Rerender an exact logical viewport patch |

There is no hydration command language, browser lifecycle API, or report-query
DSL for the agent to manage. SceneProof owns that complexity.

## Installation

SceneProof is Bun-native and uses an existing local Chrome or Chromium
installation. The linked source-mode command is the recommended path for
inspecting arbitrary workspaces.

<details>
<summary><strong>Install from source</strong></summary>

```bash
git clone https://github.com/ReyJ94/SceneProof.git
cd SceneProof
bun install
bun link
sceneproof --help
```

The legacy `uiscene` binary remains available as a compatibility alias.

If Chrome is not installed at a standard Linux path, set
`SCENEPROOF_CHROME_PATH` to the executable.

</details>

## First visual proof

The included object-gallery scene is self-contained. Scout can reconstruct it,
focus the object gallery around a featured model, and produce a contact
sheet plus exact structural evidence.

<details>
<summary><strong>Run the included Three.js example</strong></summary>

```bash
sceneproof tree examples/three/object-gallery.ts \
  --export createScene

sceneproof scout examples/three/object-gallery.ts \
  three:collection \
  --export createScene \
  --focus-node three:featured-model \
  --out artifacts/object-gallery-scout
```

Open `artifacts/object-gallery-scout/contact-sheet.png`. The compact Scout
briefing also contains a reproducible detail command and paths to the full
camera and structure reports.

</details>

## UI workflow

SceneProof accepts a named React component export, deterministic JSON props,
source CSS, workspace aliases, and Tailwind v4 styles. Add
`data-sceneproof-id` to meaningful production or inspection-only targets when
their identity should remain stable across source changes.

<details>
<summary><strong>Inspect and rerender a React target</strong></summary>

```bash
sceneproof tree tests/fixtures/DemoCard.tsx \
  --export DemoCard \
  --props tests/fixtures/props.json

sceneproof node tests/fixtures/DemoCard.tsx \
  dom:demo-card \
  --export DemoCard \
  --props tests/fixtures/props.json

sceneproof render tests/fixtures/DemoCard.tsx \
  dom:demo-card \
  --export DemoCard \
  --props tests/fixtures/props.json \
  --scale 4 \
  --out artifacts/demo-card.png
```

For a smaller logical patch, use `render-region`. The patch is reconstructed at
the requested device scale rather than cropped from an earlier screenshot.

</details>

## Three.js workflow

A Three.js entry exports `createScene(context)` and returns at least
`{ scene, camera }`. Give meaningful objects a stable
`object.userData.sceneproofId`.

Camera composition precedes pixel density. Choose a useful perspective, move
closer, center the relevant world-space patch, and only then increase render
scale to inspect point kernels, thin geometry, materials, aliasing, or shader
detail.

<details>
<summary><strong>Inspect, Scout, and rerender a Three.js target</strong></summary>

```bash
sceneproof node examples/three/object-gallery.ts \
  three:collection \
  --export createScene

sceneproof scout examples/three/object-gallery.ts \
  three:collection \
  --export createScene \
  --focus-node three:featured-model \
  --out artifacts/object-gallery-scout

sceneproof render examples/three/object-gallery.ts \
  three:collection \
  --export createScene \
  --view front \
  --zoom 4 \
  --look-at=-2.4,0.2,0 \
  --scale 4 \
  --isolate \
  --out artifacts/object-gallery-detail.png
```

`--view` accepts `front`, `side`, `top`, `isometric`, or exact
`azimuth,elevation` degrees. `--look-at` and Scout's `--focus-node` provide
coordinate and semantic focus respectively.

</details>

## Current scope

SceneProof currently supports:

- TypeScript and JavaScript source entries;
- React DOM, computed styles, semantic text and roles, SVG subtrees, and
  logical-region rendering;
- workspace `@/` imports, JSON props, source CSS, and Tailwind v4;
- Three.js scene graphs, transforms, world bounds, BufferGeometry attributes,
  materials, shader uniforms, textures, lights, cameras, and relationships;
- full-quality source rerendering, isolation, camera control, region rendering,
  Scout contact sheets, and compact evidence briefings.

SVG-native export and before/after `compare` are not implemented yet. The Bun
compiled binary is experimental for arbitrary workspace entries with nested
package imports; linked source mode is the supported development path.

## Development

<details>
<summary><strong>Local quality gate</strong></summary>

```bash
bun run check
```

The public gate runs lint, strict TypeScript 7 typechecking, the self-contained
browser-backed test harness, and the Bun compiled build.

</details>

## License

[MIT](LICENSE) © 2026 ReyJ94
