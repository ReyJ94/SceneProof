# Changelog

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

[0.2.0]: https://github.com/ReyJ94/SceneProof/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ReyJ94/SceneProof/releases/tag/v0.1.0
