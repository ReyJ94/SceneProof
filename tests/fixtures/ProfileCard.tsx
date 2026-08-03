type ProfileCardProps = {
  readonly profile: {
    readonly amplitude: number;
    readonly entryRatio: number;
    readonly waves: number;
  };
};

export function ProfileCard({ profile }: ProfileCardProps) {
  return (
    <section
      data-sceneproof-id="profile-card"
      style={{
        background: "rgb(18, 24, 38)",
        borderRadius: `${profile.waves * 3}px`,
        color: "white",
        padding: "16px",
        transform: `translateX(${profile.entryRatio * 10}px)`,
        width: `${180 + profile.amplitude}px`,
      }}
    >
      amplitude {profile.amplitude}, waves {profile.waves}
    </section>
  );
}
