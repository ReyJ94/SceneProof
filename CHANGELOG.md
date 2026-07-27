# Changelog

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

[0.4.0]: https://github.com/ReyJ94/SceneProof/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ReyJ94/SceneProof/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ReyJ94/SceneProof/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ReyJ94/SceneProof/releases/tag/v0.1.0
