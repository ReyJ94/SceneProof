type SharedProps = {
  model: {
    menuStage: string;
    nested: {
      count: number;
    };
  };
};

type PresentationProps = {
  enabled: boolean;
  labels: string[];
  title: string;
};

export type TypedPropsPanelProps = SharedProps & PresentationProps;

export function TypedPropsPanel(props: TypedPropsPanelProps) {
  return (
    <section data-sceneproof-id="typed-props-panel">
      <h1>{props.title}</h1>
      <p>{props.model.menuStage}</p>
      <output>{props.model.nested.count}</output>
      <span>{props.enabled ? "enabled" : "disabled"}</span>
      <small>{props.labels.join(",")}</small>
    </section>
  );
}
