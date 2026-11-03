---
name: sceneproof
description: >-
  Use whenever a change can alter rendered output — components, styles, layout,
  SVG, canvas, scenes, cameras, lights, materials, animation — before claiming
  that something looks right, is visible, or renders correctly, and when
  diagnosing why something is invisible, black, clipped, misframed, or
  mis-lit.
---

# SceneProof: seeing before claiming

You have a tool that can render the real source and show you real structure.
That changes what you are allowed to claim. A passing build, a clean
typecheck, or code that "should" produce the right output is **zero visual
evidence**. If you are about to assert anything about appearance, you either
have an artifact you actually looked at, or you say plainly that the visual
result is unverified.

The CLI (`sceneproof --help`, per-command help, and mechanically grounded
`suggestions` when available) tells you what commands exist and what evidence
it can gather next.
Before a serious review, run `sceneproof --version` and `sceneproof doctor`.
Do not spend a debugging session against a stale installed binary; inspect the
doctor installation block and use its reinstall command when installed-bin
readiness fails.
Run it directly on the host: it renders from source and needs no sandboxed
desktop or browser automation. When it lacks a capability a claim needs, report
the gap for the tool's own repository instead of working around it with ad-hoc
screenshots.
This skill is about something the CLI cannot do for you: choosing what
uncertainty to resolve, in what order, and judging the result honestly.

## First: name the purpose

Before claim-directed work, state the visual claim as a falsifiable question.
"Is the price label legible at the size it ships at?", "Is the selected card
visibly distinct from the others?", and "Does the model silhouette match the
reference front view?" imply different evidence.
Exploration is also legitimate: when you do not yet know the right question,
name the uncertainty you are exploring rather than pretending the command is a
verification. In either mode, know why you are gathering the evidence and do
not let an exploratory artifact silently become proof of a stronger claim.

## Resolve uncertainty in order, cheapest decisive evidence first

Visual failures have layered causes. Work down this ladder and spend effort
at the layer that is actually unknown:

1. **Boundary** — am I looking at the real production component or scene
   owner, or a lookalike? Evidence about a stand-in proves nothing about the
   app.
2. **State** — do the props, fixtures, actions, and time represent the state
   being claimed? A default-props render cannot verify a claim about the
   selected/error/dense state.
3. **Structure** — does the target exist, with sane bounds, visibility,
   geometry, material, lights? Use `tree` or `node` first when the boundary,
   target, bounds, or visibility is uncertain.
4. **Framing** — does the camera/viewport actually present the target at an
   informative size and angle?
5. **Raster** — only once framing is right: are more freshly rendered pixels
   needed to judge typography, edges, or material detail?
6. **Coherence** — does the change hold up in context, next to its
   neighbors, under the states and viewports that matter? For Three.js, render
   `--context-pair` to get declared context and isolation from one lifecycle,
   not two separately staged scenes that can silently drift apart. For React,
   use the real wrapper/provider fixture and explicit CSS cascade that supply
   the claimed context.

The classic waste is buying pixels for a structure problem: rendering at 8x
when the mesh has zero bounds, or screenshotting a component whose state
never entered the claimed condition. Enlarging an uninformative image
produces a larger uninformative image.

## Match the evidence operator to the claim

| Applicability | Operation | Reject as proof when |
| --- | --- | --- |
| Owner, target, or rendered structure is uncertain | Use `inspect` for the saved full structure, `tree` for navigation, and `node` for one target and its immediate relationships. Use `props` to derive a typed React fixture skeleton. | The export or semantic target is wrong, required state was synthesized, or structural presence is being treated as visual adequacy. |
| Discrete states must be compared | Use `matrix` for 2–12 labeled, nested prop variants at one viewport. Run a separate matrix at each materially different viewport; use `sheet` only to collect attributable outputs across runs. | A required state or viewport is absent, variants changed unrelated inputs, or raster delta is being treated as a winner. |
| Existing pixels lack local detail | Use `render-region` to rerender the logical patch from source at the required scale. | The evidence is a crop, interpolation, or enlargement of an earlier raster. |
| The useful Three.js camera is unknown | Use `scout`, inspect its contact sheet, then rerender the selected view and framing explicitly. | A candidate score or recommendation is substituted for looking, or scale is increased while framing remains the limiting factor. |
| Context may change perception | Use Three.js `--context-pair`; for React, render through the real contextual fixture. | Context and isolation came from drifting scene instances, or the wrapper reimplemented the behavior under test. |
| The claim concerns shipped Three.js size | Use literal source-camera `--delivery-review`; add `--delivery-scale` when target height is an explicit mechanical requirement. | A fitted, filled, zoomed, or high-density detail view is presented as delivery evidence. |
| The claim concerns a transition | Use fixture-owned `--action` and one `--frames` lifecycle: checkpoints for named moments, a continuous range for intervening motion. | Before and after were separately posed, or sparse checkpoints are claimed to cover unsampled motion. |
| The claim concerns React motion, or a whole page over time | Use `session`: one headless lifecycle whose fixture-owned seek and fence drive an exact clock, with no frame cap. `render --frames` serves Three.js scenes only. The harness emulates reduced motion, so the fixture must allow motion. For long or layered recordings (a demo or product video, interface over a GPU scene, overnight runs), read `references/long-captures.md` first. | Frames came from a screenshot loop, or emulated reduced motion froze the component into one frame. |
| The constraint is a supplied image or silhouette | Use `--reference` or `--reference-set`; constrain subject extraction when needed and inspect the saved mask overlay. Use `--silhouette` for target contour evidence. | The mask selects the wrong subject, extraction is low-confidence, or an aggregate hides a weak perspective. |
| A prior raster is the baseline | For a same-size Three.js render use `--compare`; use `sheet --compare` only for meaningful adjacent labeled PNGs. Hold all evidence inputs stable except the claimed change. | Source, state, viewport, target, camera, framing, backend, or delivery size changed unintentionally. |
| The graphics backend is part of the claim | Run `doctor` for the required backend and render with explicit `--three-backend webgl|webgpu`. | Software rasterization or a different backend is silently generalized to the shipping pipeline; WebGPU never permits silent WebGL fallback. |

## Structure before pixels

"Why can't I see it?" is almost never answered by another render. Hidden
ancestor, zero-size bounds, fully transparent material, no light reaching
the surface, object behind the camera, clipped by near/far planes — these
are *different* causes with different fixes, and `tree`/`node` distinguish
them in one cheap step. Diagnose invisibility structurally; render to
confirm the fix, not to hunt for the cause. When the structure is right and the
render is still wrong, the cause sits in the shader, colour pipeline, or GPU
state, which the `threejs` skill covers.

The converse also holds: a node present in structural output is not
necessarily visible. Structure explains the render; only a render you looked
at evaluates it. Neither substitutes for the other.

Treat `tree` and `node` as evidence about the rendered structural model: a
**scene graph** for Three.js and rendered DOM structure for React. They are not
an accessibility audit or a source-level React component tree.
For Three.js visibility, reason explicitly about world bounds, camera frustum,
near and far clipping planes, material transparency, and lighting before buying
more pixels.

## Cameras: composition before density

For 3D, an uninformative angle at high resolution is worth less than a good
angle at low resolution. When you don't know the useful camera, run `scout`
instead of guessing — but treat its output as a set of *hypotheses with
measurements*, not a verdict. Read the contact sheet yourself. The
score, coverage, and visible-signal numbers help distinguish framing, scale,
contrast, and sparse-signal problems. They do not establish occlusion or visual
adequacy on their own. Prefer a tighter region, closer framing, or a more
revealing angle before reaching for `--scale`; increase scale only when the
relevant detail already occupies an informative part of the frame and raster
density is the last limit. A detail render at scale is real evidence, not an
approximation, but it is evidence of what is *there*, not of what ships: a
flaw visible at 8x may be invisible at delivered size, and a composition that
reads fine zoomed in may be cramped at the size it actually ships. Pair a
detail render with `--delivery-review` before claiming the shipped view is
correct. To judge aliasing, sharpness, or antialiasing itself, render at the
shipping pixel density and enlarge with nearest-neighbour only, labelled with
the factor; a higher `--scale` would hide what is being judged.

## Freshness and provenance are non-negotiable

- A capture that shows the interface over an empty or black area where a
  WebGPU or WebGL canvas should be has lost the canvas; it did not render the
  scene. Confirm the canvas content is in the frame before treating any capture
  as evidence.
- Do not treat a crop or enlargement as fresh evidence. Rerender the region
  from source when the claim needs detail the original render did not contain.
- Never build a simplified copy of production geometry, layout, or state to
  make verification easier. That verifies your copy, not the application. If
  the real boundary needs application context, reconstruct that context in the
  harness: let a React fixture own wrappers, providers, and document state; load
  the real styles in cascade order; alias browser-incompatible integrations
  explicitly. Do not change production APIs or imports to make inspection
  easier. If the real boundary still cannot load without fabricating the
  behavior under test, report that as the blocker.
- Use `matrix` for labeled multidimensional states. A checksum-guarded source
  overlay is an attributable last resort for a sealed React constant, not a
  license to rewrite production files or hide state from provenance.
- Derive a **state-by-viewport evidence matrix** from the visual claim rather
  than from a generic device checklist. One `matrix` invocation compares states
  at one viewport; use distinct runs for materially different viewports. Include
  a combination only when state, viewport, context, or interaction changes the
  visual oracle or delivered judgment. Time is a state: for live simulations,
  include the long-run state, minutes in, not only the first frame.
- For a **visual regression baseline**, keep the real owner, deterministic
  fixture, state, viewport, target, camera, framing, graphics backend, and
  delivery size stable between baseline and candidate unless one is the claimed
  change. Changing the evidence setup and source together confounds the
  comparison.
- Know what state you actually rendered. Synthesized placeholder props are
  labeled in the report — do not let them silently stand in for real state
  in your conclusion.
- Transition claims need one real lifecycle (construct once, act once,
  sample frames of that same scene). Two separately hand-posed renders do
  not establish that a transition happens.
- Treat `--frames before,0,120,settled` as checkpoints: it says nothing about
  the unsampled interval. Use `--frames 0..3000@100ms` when the claim concerns
  continuous motion, then inspect `motion.apng` and `motion-map.png` as well as
  representative frames.
- Route diagnostic shader channels through explicit fixture props so the
  evidence is reproducible. Altered lights, exposure, tone mapping, or debug
  materials can isolate a cause, but they are diagnostic evidence—not the
  canonical shipping appearance. Return to the real pipeline before approval.

## Inspector ownership

Use an existing application export directly when it already returns the real
visual owner. Otherwise use `defineReactFixture` or `defineThreeFixture` in a
thin inspector that imports the production owner unchanged and supplies only
deterministic context, state, semantic targets, domain actions, and cleanup. If
the adapter copies geometry, camera values, layout, or behavior, it has become a
lookalike rather than an inspector.

Keep reusable repository inspectors in
`<repository>/scripts/sceneproof/` as `<surface>.scene.ts` or
`<surface>.scene.tsx`, and reusable state fixtures in
`<repository>/scripts/sceneproof/fixtures/`. Keep disposable investigation in
`/tmp/sceneproof-inspectors/`. Inspector tooling does not belong in application
`src`, routes, or production bundles.

## Read the report for what it can establish

SceneProof has no model inside it. It does not know whether a composition is
good or whether one heuristic makes the artifact adequate for your question.
Keep these report layers separate:

- **execution** succeeded = the command ran. Nothing more. How long a capture
  took says nothing about real frame time; SceneProof does not measure
  performance.
- **artifacts** are the files you must actually open.
- **provenance** says what source, state, context, CSS, substitutions, and
  overlays produced those files. A declared stub or synthesized prop is a real
  boundary on what you can conclude.
- **facts** and **warnings** are measurements and concrete limitations, not a
  visual verdict. A luminance spread, target coverage, or Scout score may help
  diagnose a frame without deciding whether the frame answers your question.
- **assertions** pass or fail only a mechanical condition explicitly requested
  in the command. Passing one does not approve the design around it.
- **review.required** means the contextual decision remains yours. Open the
  artifact. Actually look at it before making a visual claim.

Start with the compact briefing. Use `--json` when the decision depends on the
complete factual report; a fact omitted from the briefing is not necessarily a
fact SceneProof failed to collect.

A fresh render is a **visual test oracle** only for the appearance represented by
its recorded source, state, viewport, context, and framing. It cannot establish a
different state or delivery condition, and structural presence cannot substitute
for perceptual judgment.

For reference comparisons, confirm the mask/overlay sits on the intended
subject before trusting any metric derived from it. For matrices, compare the
labeled images rather than accepting raster delta as a preference. A precise
number about the wrong subject, state, or region is worse than no number.

When the evidence spans different commands or scales, `sheet` can put the
labeled PNGs into one artifact. Use it for combinations such as context plus
detail, before plus after, or render plus reference. It packages what you give
it; it does not make an old image fresh or recover the source and state
provenance from the command that produced it. Keep those originating reports,
and request `--compare` only for adjacent frames whose raster difference is
meaningful.

## Report like a witness, not an advocate

State what was rendered (source and state provenance), which states and
viewports were exercised, where the artifacts are, and what you concluded by
looking. A negative or unresolved result is a valid result: "the label clips
at 320px and I have the render showing it" is a better report than an
unverified "looks good". The strongest failure mode this skill exists to
prevent is declaring visual success from non-visual evidence. When you have
eyes, use them; when you didn't, say so.
