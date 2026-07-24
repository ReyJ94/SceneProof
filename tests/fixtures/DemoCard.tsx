import "./DemoCard.css";

type DemoCardProps = {
  readonly title: string;
};

export function DemoCard({ title }: DemoCardProps) {
  return (
    <section className="demo-card" data-sceneproof-id="demo-card">
      <h1 className="demo-title" data-sceneproof-id="demo-title">
        {title}
      </h1>
      <button className="demo-action" type="button">
        Continue
      </button>
    </section>
  );
}
