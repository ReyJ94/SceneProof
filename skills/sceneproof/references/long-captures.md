# Recording a real app or scene over time

How to turn a running application or GPU scene into a long, layered frame
sequence (a product video, a demo, a motion study) with `sceneproof session`,
and hand it to a compositor.

Read [session.md](../../../docs/session.md) for the API. This page covers how to use it for
long work and what went wrong the first time.

## Who owns what

| Owner | Owns |
| --- | --- |
| **Your source** (the app, the scene, the session script) | State, the clock it runs on, readiness and draw fences, every step that moves the story (input, typing, cues), camera and look. |
| **SceneProof** | One headless browser and page, GPU admission, capture, the exact frame clock, immutable files with hashes, source identity, resume checks. |
| **The compositor** (Remotion, ffmpeg, …) | Cuts, timing, dissolves, titles, sound, grading, the final encode. |

Keep that split. If a session script starts doing cuts or titles, or the
compositor starts guessing app state, move the work back to its owner.

## 1. Render the real app; replace only its edges

Mount the application's own components through the session's `source` and
`aliases`; don't rebuild the interface for the recording. A rebuilt copy drifts
from the product, and every fix lands twice. Swap out only what can't run
headlessly or must be scripted:

- **clock:** `performance.now`, `requestAnimationFrame` and Web Animations on
  recording time (an `init` module), one step and draw per frame;
- **network:** answers served in the page from exported, read-only state, with
  the time advanced by the script's own events;
- **identity, voice, other services:** small aliases that return what the real
  service would, timed on the recording's clock;
- **observation:** read the app's own state hooks and write what the
  compositor needs into each frame's receipt.

Check the scripted answers against the app's own schemas. The app rejects
malformed IDs and versions, and the failure shows up far from its cause.

## 2. Own the clock and say what isn't on it

- Use `frameClock(index, fps)`: rational seconds, frames `0 … N-1` (a 3 s clip
  at 30 fps ends at 89/30, not at 3 s). An event at time *t* applies on the
  first frame at or after *t*; record both times.
- `seek` advances the source by exactly one step; `fence` waits for the real
  draw (GPU queue completion), not a sleep.
- Anything still on wall-clock time will differ between runs: spinners, CSS
  animations outside the shimmed clock, idle spell-check marks. Find them by
  rendering the same frame twice and diffing. Shim them, or list them as known
  differences.
- Set the page's environment on purpose: colour scheme, motion preference
  (SceneProof emulates reduced motion, so the source must allow motion),
  spell-check off on editables.

## 3. Capture layers separately

Capture the GPU world and the transparent interface as separate layers from
the same frame, and composite later. That lets you blur, grade, re-time or
re-render one layer without re-recording the other.

- Write the per-frame facts the compositor needs into a JSON receipt next to
  each frame: pointer position, regions the interface covers, blur ellipses,
  labels, state. The compositor reads them; it never infers state from pixels.
- If the page applies a CSS effect to the canvas (for example `backdrop-filter`),
  the canvas layer won't contain it. Record its parameters per frame and apply
  them in the compositor.
- Hide temporary interface elements by pixels only (opacity 0, keep layout and
  click targets), and assert before every capture that they are hidden, so the
  run fails by name if the markup changes.

## 4. Pin the source you approved

The working tree includes everyone's uncommitted edits at the moment of the
run. When a shot's look is approved, record the commit it was rendered on,
and render that shot from that commit next time (`--source-overlays` or a
separate checkout). Prove a re-render against the approved one bit for bit
inside the frame before trusting a tooling change. That check also catches
plain bugs, such as a noise seed that silently became NaN.

## 5. Post effects that read past the border need overscan

Lens distortion, depth of field and other effects that sample neighbouring
pixels repeat the edge pixel past the frame border, which shows up as streaks
once bright detail reaches the edge. Render a margin around the frame (widen
the viewport and the projection together), compute the finish in frame
coordinates, and crop the margin when encoding. Shots whose placement is
solved in frame pixels can't use a margin; mirror reads at the border instead.

## 6. Long runs

- **Sources usually can't seek.** A piece covering frames `[a, b)` steps from
  frame 0 and keeps only `a … b-1`. Split a long sequence into parallel pieces
  only when that shortens the total time (each split re-steps frames), and
  join pieces by hard link, not by re-encoding.
- **Run outside your agent's process tree.** An agent or IDE restart kills
  every browser it started. Use an independent service (`systemd-run --user`
  without `--scope`, or the machine's job runner), keep the machine awake
  (`systemd-inhibit`), and don't set time limits on steps.
- **Admit work by measured memory**, not by guesses: measure one piece's peak
  RAM and GPU memory first, and start another only if what remains stays free.
  Memory over-commit kills or swaps; CPU contention only slows.
- **Keep the plan you started with.** Save the piece plan and reuse it on
  restart. A plan regenerated from current free memory changes piece
  boundaries and identities.
- **Restart only from committed frames.** A frame counts when its receipt
  exists; an image without a receipt is an orphan and is recaptured. Resume
  with `--resume` and the same inputs. Use a new output directory whenever the
  source, camera module or props change.
- **Fail loudly at step boundaries.** Record each finished step, keep the
  failed exit status under a new name before restarting, and append to the
  same log. Resume by skipping finished steps, not by re-running the chain
  from scratch.

## 7. Hand-off and final checks

- Give the compositor the run directories and their receipts; it reads frame
  files and facts by index from the receipts, never by guessing filenames.
- Keep mastered audio from the approved file itself. A pre-master WAV is not
  the same level.
- Point the compositor's temporary files at a real disk: `/tmp` on tmpfs with
  quotas fails long exports (`EDQUOT`).
- Validate the final file: probe it (codec, size, frame count, duration),
  decode it end to end, inspect sampled frames across every scene, and compare
  the audio against its approved sources. Report sampled review as sampled,
  not as having watched every frame.

## What SceneProof does not do

No cameras, story cues, cursor scripting, lens or visual look, editing, sound
mixing or job scheduling. Those belong to your source, your session script,
the compositor or the machine's job runner.
