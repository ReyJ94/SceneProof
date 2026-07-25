import type {
  Box3,
  Camera,
  InstancedMesh,
  Object3D,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";

export type ThreeFixtureContext<Props = Record<string, unknown>> = {
  assets: Record<string, unknown>;
  height: number;
  pixelRatio: number;
  props: Props;
  width: number;
};

export type ThreeSemanticTargetMember =
  | {
      instanceId: number;
      object: InstancedMesh;
    }
  | {
      instanceId?: never;
      object: Object3D;
    };

export type ThreeSemanticTarget = {
  bounds?: Box3 | (() => Box3);
  focus?: Vector3 | (() => Vector3);
  id: string;
  isolate?: () => void;
  label?: string;
  members?: ThreeSemanticTargetMember[];
};

export type ThreeFixtureResult = {
  actions?: Record<
    string,
    (input?: Record<string, unknown>) => void | Promise<void>
  >;
  camera: Camera;
  dispose?: () => void | Promise<void>;
  ready?: Promise<void>;
  renderer?: WebGLRenderer;
  scene: Scene;
  seek?: (timeMs: number) => void | Promise<void>;
  settle?: () => void | Promise<void>;
  targets?: ThreeSemanticTarget[];
};

export type ThreeFixtureFactory<Props = Record<string, unknown>> = ((
  context: ThreeFixtureContext<Props>
) => ThreeFixtureResult | Promise<ThreeFixtureResult>) & {
  sceneproofRenderer?: "three";
};

/**
 * Brands an arbitrarily named export for zero-probe SceneProof detection while
 * preserving the ordinary callable factory contract.
 */
export function defineThreeFixture<Props = Record<string, unknown>>(
  factory: ThreeFixtureFactory<Props>
): ThreeFixtureFactory<Props> {
  Object.defineProperty(factory, "sceneproofRenderer", {
    configurable: false,
    enumerable: false,
    value: "three",
    writable: false,
  });
  return factory;
}
