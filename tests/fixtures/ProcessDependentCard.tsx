const runtimeMode = process.env.SCENEPROOF_FIXTURE_MODE ?? "browser";

export function ProcessDependentCard() {
  return <div data-sceneproof-id="process-card">{runtimeMode}</div>;
}
