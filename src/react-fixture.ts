import type { ComponentType, ReactNode } from "react";

export type ReactFixtureDocumentTarget = {
  attributes?: Record<string, string>;
  classes?: string[];
};

export type ReactFixtureDefinition<Props = Record<string, unknown>> = {
  document?: {
    body?: ReactFixtureDocumentTarget;
    html?: ReactFixtureDocumentTarget;
    root?: ReactFixtureDocumentTarget;
  };
  render: (props: Props) => ReactNode;
};

export type ReactFixtureExport<Props = Record<string, unknown>> =
  ComponentType<Props> & {
    sceneproofReactFixture: Omit<ReactFixtureDefinition<Props>, "render">;
    sceneproofRenderer: "react";
  };

/**
 * Declares an external React inspection boundary without changing the imported
 * production component. Wrapper components and providers belong inside
 * `render`; document classes and attributes are applied before React mounts.
 */
export function defineReactFixture<Props = Record<string, unknown>>(
  definition: ReactFixtureDefinition<Props>
): ReactFixtureExport<Props> {
  const Fixture = definition.render as ReactFixtureExport<Props>;
  Object.defineProperties(Fixture, {
    sceneproofReactFixture: {
      configurable: false,
      enumerable: false,
      value: { document: definition.document ?? {} },
      writable: false,
    },
    sceneproofRenderer: {
      configurable: false,
      enumerable: false,
      value: "react",
      writable: false,
    },
  });
  return Fixture;
}
