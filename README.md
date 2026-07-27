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
  <a href="https://github.com/ReyJ94/SceneProof/releases/tag/v0.3.0"><img alt="Release v0.3.0" src="https://img.shields.io/badge/release-v0.3.0-E6A34D?style=flat-square" /></a>
</p>

SceneProof lets coding agents see the interfaces and Three.js scenes they
build. It reconstructs the real source, exposes the structure that explains the
render, and produces exactly the context or detail view needed for reliable
visual judgment.

Agents can finally recognize what they made, understand why it looks wrong, and
prove that it is visually finished—instead of coding UI and 3D blind.

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

`doctor` reports executable discovery, browser launch, WebGL availability, the
active renderer, and the required execution guidance. A failed check exits
non-zero.

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
| Match a supplied reference | Aligned silhouette, paired luminance, pixel probes, unaligned composition, and explicit-mask provenance |
| Bracket a fixture parameter | One-variable contact sheets ranked by an explicit geometry, appearance, composition, or balanced objective |
| Constrain a 3D form from several views | A labeled reference manifest evaluated per camera in one browser and one bundle |
| Preserve model context | Compact briefings with lossless evidence available by path only when needed |

SceneProof keeps two accounts of the result:

- **Structural truth:** what the source produced—hierarchy, identity, bounds,
  transforms, styles, geometry, materials, lights, cameras, and visibility.
- **Perceptual truth:** what the result presents—composition, hierarchy,
  silhouette, depth, density, contrast, clipping, and small-scale detail.

The render reveals that something is wrong. The structure often reveals why.
Neither replaces the other.

`inspect` and `scout` return compact, decision-complete briefings. Warnings,
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
    { "label": "hero", "view": "original", "path": "hero.png", "maskPath": "hero-mask.png" },
    { "label": "side", "view": "side", "path": "side.png", "maskPath": "side-mask.png" }
  ]
}
```

```bash
sceneproof render scripts/sceneproof/monument.scene.ts three:monument \
  --reference-set references.json \
  --out artifacts/monument-reference-set
```

Each labeled view retains its own camera, mask, artifacts, and score. The
aggregate never substitutes one perspective for another.

## Agent-facing surface

| Verb | Purpose |
| --- | --- |
| `tree` | Navigate semantic structure |
| `node` | Inspect one exact target and its immediate relationships |
| `inspect` | Reconstruct the source and preserve the canonical scene artifact |
| `scout` | Discover useful Three.js target cameras in one scene lifecycle |
| `render` | Produce fresh context or target evidence |
| `render-region` | Rerender an exact logical viewport patch |
| `doctor` | Prove Chromium and WebGL readiness and explain required permissions |

SceneProof owns renderer setup and evidence persistence. The agent chooses the
real source boundary, declared state, semantic target, framing, and evidence
needed to resolve the uncertainty.

## First visual proof

The included object-gallery scene is self-contained:

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
briefing explains whether framing or raster resolution is limiting and provides
reproducible commands for the useful alternatives.

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

`--view original --framing source` preserves the complete source camera
literally. `fit` contains the target. `fill` prioritizes target visibility and
allows controlled clipping for close inspection. Scout provides four different
evidence intentions:

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

For the exact lifecycle, semantic target, instance ID, camera, and diagnostic
contracts, read [the Three.js fixture protocol](docs/three-fixtures.md).

## Current scope

SceneProof currently supports:

- TypeScript and JavaScript source entries;
- React DOM, computed styles, semantic text and roles, SVG subtrees, and
  logical-region rendering;
- workspace `@/` imports, JSON props, source CSS, and Tailwind v4;
- Three.js scene graphs, transforms, world bounds, BufferGeometry attributes,
  materials, shader uniforms, textures, lights, cameras, and relationships;
- custom-named Three.js factories, deterministic props/actions/time, source
  camera preservation, semantic targets, stable `InstancedMesh` instance IDs,
  and single-lifecycle frame sequences;
- full-quality source rerendering, target-aware camera control, bounded source
  region rendering, information-gain Scout portfolios, and compact evidence
  briefings.

SVG-native export and before/after `compare` are not implemented yet. The Bun
compiled binary is experimental for arbitrary workspace entries with nested
package imports; linked source mode is the supported development path.

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
browser-backed test harness, and the Bun compiled build.

</details>

See [the changelog](CHANGELOG.md) for release-level behavior changes.

## License

[MIT](LICENSE) © 2026 ReyJ94
