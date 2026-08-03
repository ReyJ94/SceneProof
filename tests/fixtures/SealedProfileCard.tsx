const SEALED_PROFILE = { amplitude: 12, entryRatio: 0.18, waves: 2 };

export function SealedProfileCard() {
  return (
    <section
      data-sceneproof-id="sealed-profile-card"
      style={{
        border: `${SEALED_PROFILE.waves}px solid rgb(80, 100, 140)`,
        marginLeft: `${SEALED_PROFILE.entryRatio * 20}px`,
        width: `${160 + SEALED_PROFILE.amplitude}px`,
      }}
    >
      sealed profile
    </section>
  );
}
