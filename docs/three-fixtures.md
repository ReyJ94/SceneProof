# Three.js fixture protocol

SceneProof fixtures make source state deterministic without inventing a generic
interaction language. The fixture owns the scene lifecycle and domain actions;
SceneProof owns selection, evidence, camera framing, and capture.

## Inspector ownership and provenance

Prefer an existing application export when it already creates the real scene
and camera. When extra setup is needed, treat the adapter as repository tooling:

```text
<repository>/
  scripts/
    sceneproof/
      gallery.scene.ts
      fixtures/
        selected.json
        select-action.json
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

It must not copy or approximate production geometry, geometry, camera values,
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

For ordinary `InstancedMesh` data, assign one ID per active instance:

```ts
mesh.userData.sceneproofInstanceIds = nodeIds;
```

SceneProof derives each instance's exact world bounds from its geometry bounding
box, instance matrix, and mesh world matrix. This makes the instance frameable
without rebuilding one scene per item. If exact visual isolation requires
shader or buffer changes, expose an explicit target with `isolate`.

## Camera semantics

Rendering has two independent controls:

- `--view original|front|side|top|isometric|azimuth,elevation` chooses the
  camera orientation source.
- `--framing source|fit|fill` chooses whether the source camera remains literal
  or is reframed around the target.

`--view original --framing source` clones the fixture camera without changing
its transform or projection. Reports include both `camera.source` and
`camera.resolved` plus `camera.modified`.

`fit` contains the target with margin. `fill` moves closer and permits
controlled clipping for detail inspection. `--scale` changes raster density;
it does not move the camera and cannot recover information absent from the
frame.

## Scout evidence portfolio

Scout returns four intent-specific recommendations:

- `context`: the literal source-camera view;
- `sourceDetail`: a fresh rerender of the target's padded projected region
  while preserving source composition;
- `detail`: a close target-camera view selected primarily by target visibility;
- `shape`: an alternate view selected for useful edge and contrast evidence.

The report includes `diagnosis.limitingFactor`. When the target is too small,
the answer is `framing`, not higher image quality. Additional raster scale is
appropriate only after the target already occupies an informative portion of
the frame. Open the contact sheet and judge the alternatives; the numeric
ranking narrows inspection but does not replace visual judgment.

## Execution diagnostics

SceneProof requires local Chromium and WebGL. In an agent sandbox, invoke it as
the direct command with unsandboxed/local-render permission:

```bash
sceneproof doctor
```

Do not bury the invocation in a pipe or compound shell when requesting that
permission. `doctor` exits non-zero if Chromium cannot launch or WebGL is not
available and returns the detected executable and renderer on success.
