type NestedPropsCardProps = {
  readonly model: {
    readonly menuStage: string;
  };
};

export function NestedPropsCard({ model }: NestedPropsCardProps) {
  return <div data-sceneproof-id="nested-props">{model.menuStage}</div>;
}
