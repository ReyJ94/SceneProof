---
name: sceneproof
description: Visual reasoning discipline for verifying UI and Three.js work with the SceneProof CLI. Use whenever a change can alter rendered output — components, styles, layout, SVG, canvas, scenes, cameras, lights, materials, animation — or whenever about to claim that something "looks right", "is visible", or "renders correctly". Also use when debugging why something is invisible, black, clipped, misframed, or mis-lit.
---

# SceneProof: seeing before claiming

You have a tool that can render the real source and show you real structure.
That changes what you are allowed to claim. A passing build, a clean
typecheck, or code that "should" produce the right output is **zero visual
evidence**. If you are about to assert anything about appearance, you either
have an artifact you actually looked at, or you say plainly that the visual
result is unverified.

The CLI (`sceneproof --help`, per-command help, and the `recommendations`
field in every report) tells you what commands exist and what to run next.
This skill is about something the CLI cannot do for you: choosing what
uncertainty to resolve, in what order, and judging the result honestly.

## First: name the question

Before running anything, state the visual claim as a falsifiable question.
"Check the UI" is not a question. "Is the price label legible at the size it
ships at?", "Is the selected item visibly distinct from unselected
ones?", "Does the geometry silhouette match the reference front view?" — these
are questions, and each one implies different evidence. Every command you run
should exist to answer the named question. If you can't say which question a
render answers, don't run it.

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
   geometry, material, lights? Ask `tree` and `node` before rendering
   anything.
4. **Framing** — does the camera/viewport actually present the target at an
   informative size and angle?
5. **Raster** — only once framing is right: are more freshly rendered pixels
   needed to judge typography, edges, or material detail?
6. **Coherence** — does the change hold up in context, next to its
   neighbors, under the states and viewports that matter?

The classic waste is buying pixels for a structure problem: rendering at 8x
when the mesh has zero bounds, or screenshotting a component whose state
never entered the claimed condition. Enlarging an uninformative image
produces a larger uninformative image.

## Structure before pixels

"Why can't I see it?" is almost never answered by another render. Hidden
ancestor, zero-size bounds, fully transparent material, no light reaching
the surface, object behind the camera, clipped by near/far planes — these
are *different* causes with different fixes, and `tree`/`node` distinguish
them in one cheap step. Diagnose invisibility structurally; render to
confirm the fix, not to hunt for the cause.

The converse also holds: a node present in structural output is not
necessarily visible. Structure explains the render; only a render you looked
at evaluates it. Neither substitutes for the other.

## Cameras: composition before density

For 3D, an uninformative angle at high resolution is worth less than a good
angle at low resolution. When you don't know the useful camera, run `scout`
instead of guessing — but treat its output as a set of *hypotheses with
measurements*, not a verdict. Read the contact sheet yourself. The
score/coverage/visible numbers tell you *why* a view fails (target out of
frame vs. present but tiny vs. occluded), which is diagnosis you should
reason from. Prefer a tighter region, closer framing, or a more revealing
angle before reaching for `--scale`; increase scale only when the relevant
detail already occupies an informative part of the frame and raster density
is the last limit.

## Freshness and provenance are non-negotiable

- Never crop or enlarge an existing PNG to "look closer" — rerender the
  region from source. A crop cannot contain detail that was never rendered.
- Never build a simplified copy of production geometry, layout, or state to
  make verification easier. That verifies your copy, not the application. If
  the real boundary can't load, report that as the blocker instead of
  approximating around it.
- Know what state you actually rendered. Synthesized placeholder props are
  labeled in the report — do not let them silently stand in for real state
  in your conclusion.
- Transition claims need one real lifecycle (construct once, act once,
  sample frames of that same scene). Two separately hand-posed renders do
  not establish that a transition happens.

## Read the verdict for what it is

Every report separates three things. Keep them separate in your reasoning:

- **execution** succeeded = the command ran. Nothing more.
- **evidence** `judgeable` = the artifact can support the named question.
  `unjudgeable` or `partially-judgeable` means the evidence is defective —
  fix the framing, mask, state, or dynamic range and re-gather. Do not
  soften it into "roughly confirms".
- **assessment** with `decisionOwner: agent` means the judgment is yours and
  it hasn't been made yet. Open the artifact. Actually look at it —
  hierarchy, spacing, clipping, contrast for UI; silhouette, scale, lighting
  response, occlusion, depth for 3D — in context, not just in isolation.

For reference comparisons, confirm the mask/overlay sits on the intended
subject before trusting any metric derived from it. A precise number about
the wrong region is worse than no number.

## Report like a witness, not an advocate

State what was rendered (source and state provenance), which states and
viewports were exercised, where the artifacts are, and what you concluded by
looking. A negative or unresolved result is a valid result: "the label clips
at 320px and I have the render showing it" is a better report than an
unverified "looks good". The strongest failure mode this skill exists to
prevent is declaring visual success from non-visual evidence. When you have
eyes, use them; when you didn't, say so.
