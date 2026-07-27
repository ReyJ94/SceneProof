# Changelog

## [0.6.0] - 2026-07-28

### Added

- Explicit `--projection source|perspective|orthographic` evidence cameras,
  including attributable camera conversion and exact front/side blueprint
  orientations.
- Repeatable normalized foreground/background seeds for reference extraction,
  persisted candidate masks and cyan verification overlays, component and
  border-contact audits, and explicit `*-needs-review` verification states.
- A 101-sample silhouette profile with per-height left, right, and width deltas,
  width RMSE, maximum disagreement, and contiguous too-wide/too-narrow ranges.
- Unified multi-view contact sheets, per-view projection and seed ownership, and
  worst-view reporting without allowing one perspective to substitute for
  another.
- Point-of-use next actions and required artifact-review questions on reference
  runs, plus sweepability reports that identify fixture props with no visual
  effect and explain that hidden module constants are not rewritten.

### Changed

- Seed-assisted confidence is assessed from foreground/background separation
  rather than being capped by an annotated or otherwise nonuniform border; the
  resulting mask still requires semantic review before any match claim.
- Orthographic `fit` framing uses the target's projected extent and a stable
  camera-up axis, preventing top views from being shrunk by depth that is not
  visible in that projection.
- Reference review sheets show the requested source region instead of shrinking
  an entire infographic into the comparison panel.
- Three-only bundling skips unrelated application CSS discovery while React
  rendering retains automatic source-style loading.

### Fixed

- Perspective fixtures can now produce true orthographic evidence rather than
  a perspective camera merely pointed at a nominal front or side view.
- Multi-view top evidence no longer reports successful fit framing while the
  target occupies only a few percent of the frame.
- Low-confidence extraction still persists the candidate mask and overlay, so
  an unjudgeable result supplies the evidence needed to correct it.
- Reference-aware sweeps report no-op prop paths instead of recommending an
  unchanged variant as useful evidence.

## [0.5.0] - 2026-07-27

### Added

- Explicit `--three-backend webgl|webgpu` selection across Three.js evidence
  commands, with WebGL retained as the compatibility-first default.
- Backend provenance in reports: requested and actual backend, renderer family,
  silent-fallback status, adapter identity, and rasterizer information.
- WebGPU readiness diagnostics backed by an actual GPU clear-and-readback, plus
  `doctor --require-backend any|webgl|webgpu|both` for enforceable environment
  requirements.

### Changed

- Three.js source bundles target `three/webgpu` when WebGPU is requested and
  run from a trustworthy loopback origin required by the browser API.
- The public fixture contract accepts either `WebGLRenderer` or
  `WebGPURenderer`; a supplied renderer must match the explicitly requested
  backend.

### Fixed

- WebGPU requests no longer accept Three.js's silent WebGL2 fallback as WebGPU
  evidence.
- GLSL-only materials, custom `onBeforeCompile` paths, and addons that require
  WebGL-only Three.js exports now fail with attributable TSL/NodeMaterial or
  explicit-WebGL guidance instead of producing partial or mislabeled evidence.
- Headless WebGPU capture reads the rendered GPU texture directly instead of
  trusting a transient DOM canvas presentation buffer, including frame,
  region, and Scout evidence paths.

## [0.4.0] - 2026-07-27

### Added

- Explicit `execution`, `evidence`, and `assessment` result layers. The legacy
  `success` field now has documented command-execution-only meaning; reference
  acceptance remains an agent-owned artifact comparison rather than an
  automatic similarity pass.
- Typed React props skeleton generation through `sceneproof props`, plus
  provenance-marked `--partial-props` completion for real component exports.
- Fixture-declared context members, one-lifecycle `--context-pair` evidence,
  symmetric `--in-context` and `--isolated` controls, and delivery-scale
  assertions based on logical target height.
- Fitted-spline silhouette deviation and persisted amplified difference panels
  for every adjacent frame pair.

### Changed

- Render, frame, region, Scout, sweep, and multi-view reference reports now
  distinguish successful artifact production from judgeability and visual
  outcome. Null motion, absent sweep variation, and missed delivery scale can
  fail their assertion while execution remains successful.
- TypeScript is now a runtime dependency because typed props inference uses the
  TypeScript 7 asynchronous compiler API.
- Removed the illustrative `examples/three` scene; reusable evidence fixtures
  should import a project's real visual owner under `scripts/sceneproof`.

### Fixed

- Compiled binaries run TypeScript analysis through the shipped source worker,
  keeping TypeScript's native executable and package-import resolution on the
  real filesystem instead of Bun's virtual bundle filesystem.
- Runtime dependencies resolve from both nested and normally hoisted Bun
  installation layouts; a clean tarball install no longer fails to find
  `esbuild` beside the SceneProof package.

## [0.3.0] - 2026-07-27

SceneProof now turns a supplied visual target into measurable evidence rather
than asking an agent to compare renders from memory.

### Added

- Reference images with explicit masks or bounded automatic extraction,
  aligned silhouette deltas, paired luminance histograms, normalized pixel
  probes, and reference/current/difference artifacts.
- Unaligned reference composition evidence so subject alignment cannot hide
  incorrect viewport placement or delivery size.
- One-variable fixture-prop sweeps with adjacent raster-change evidence and
  explicit `geometry`, `appearance`, `composition`, or `balanced` ranking.
- Labeled multi-view reference manifests evaluated in one browser and bundle,
  with per-perspective provenance and non-substituting aggregate fit.
- Target-only silhouette profiles, raster judgeability gates, comparison maps,
  motion summaries, and detected rasterizer provenance.

### Fixed

- Isolation preserves Three.js lights instead of silently producing an unlit
  target.
- Multi-frame output paths, transient esbuild service failure handling, bare
  semantic target IDs, Scout flag symmetry, and missing-prop render guidance.

## [0.2.0] - 2026-07-25

SceneProof now treats useful framing and faithful state reconstruction as the
primary sources of visual information, rather than recommending larger versions
of an uninformative image.

### Added

- Renderer detection based on the selected export's `{ scene, camera }` return
  contract, with explicit `--renderer` control and `defineThreeFixture` branding
  for deterministic zero-probe detection.
- Deterministic Three.js props, fixture-owned actions, exact time sampling, and
  single-lifecycle frame sequences.
- Literal source-camera rendering plus explicit `source`, `fit`, and `fill`
  framing modes.
- Scout recommendations for source context, bounded source detail, close target
  detail, and alternate shape evidence, including framing-versus-resolution
  diagnosis.
- Fixture-defined semantic targets and stable `InstancedMesh` instance IDs with
  instance-specific world bounds.
- `sceneproof doctor` with non-zero Chromium/WebGL failure diagnostics and
  direct local-render permission guidance.
- A documented repository-root `scripts/sceneproof/` convention for reusable
  inspectors and deterministic state snapshots.

### Changed

- Scout prioritizes target visibility and controlled close framing before
  recommending additional raster scale.
- `--view original` no longer silently fits the selected Three.js target when
  source framing is requested.
- Three.js fixture documentation now separates production source provenance,
  declared fixture state, and live-application parity.

### Fixed

- Valid Three.js factories no longer depend on the literal export name
  `createScene`.
- Rendered source-camera comparisons retain the fixture camera transform and
  projection.
- Batched draw owners can expose logical instance boundaries without rebuilding
  a one-item scene.
- Chromium launch failures no longer appear as successful commands with empty
  output.

## [0.1.0] - 2026-07-24

Initial public release with source-grounded React and Three.js inspection,
structural evidence, focused rerendering, and Scout camera discovery.

[0.6.0]: https://github.com/ReyJ94/SceneProof/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/ReyJ94/SceneProof/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ReyJ94/SceneProof/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ReyJ94/SceneProof/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ReyJ94/SceneProof/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ReyJ94/SceneProof/releases/tag/v0.1.0
