import {
  Box3,
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from "three";

type AdvancedSceneProps = {
  offset?: number;
};

type AdvancedSceneContext = {
  height: number;
  pixelRatio: number;
  props?: AdvancedSceneProps;
  width: number;
};

type SelectInput = {
  lift?: number;
};

export function createConfiguredScene(context: AdvancedSceneContext) {
  const scene = new Scene();
  scene.name = "Advanced fixture";
  scene.userData.sceneproofId = "advanced-fixture";
  scene.background = new Color("#080a12");

  const focus = new Mesh(
    new BoxGeometry(2, 2, 2),
    new MeshBasicMaterial({ color: "#f2a65a" })
  );
  focus.name = "Focus object";
  focus.userData.sceneproofId = "focus-object";
  focus.position.set(context.props?.offset ?? 0, 0, 0);

  const contextObject = new Mesh(
    new BoxGeometry(1, 1, 1),
    new MeshBasicMaterial({ color: "#6aa9ff" })
  );
  contextObject.name = "Context object";
  contextObject.userData.sceneproofId = "context-object";
  contextObject.position.set(-16, 8, -4);
  const instances = new InstancedMesh(
    new BoxGeometry(1, 1, 1),
    new MeshBasicMaterial({ color: "#9f7aea" }),
    2
  );
  instances.name = "Batched objects";
  instances.userData.sceneproofId = "batched-objects";
  instances.userData.sceneproofInstanceIds = [
    "instance-alpha",
    "instance-beta",
  ];
  instances.setMatrixAt(0, new Matrix4().makeTranslation(10, 0, 0));
  instances.setMatrixAt(1, new Matrix4().makeTranslation(14, 0, 0));
  instances.instanceMatrix.needsUpdate = true;
  scene.add(focus, contextObject, instances);

  const camera = new PerspectiveCamera(
    38,
    context.width / context.height,
    0.25,
    250
  );
  camera.name = "Advanced source camera";
  camera.position.set(7, -11, 9);
  camera.up.set(0, 0, 1);
  camera.lookAt(focus.position);
  camera.updateMatrixWorld(true);

  let elapsed = 0;
  return {
    actions: {
      select(input: SelectInput = {}) {
        focus.position.z += input.lift ?? 2;
        focus.updateMatrixWorld(true);
      },
    },
    camera,
    dispose() {
      focus.geometry.dispose();
      focus.material.dispose();
      contextObject.geometry.dispose();
      contextObject.material.dispose();
      instances.geometry.dispose();
      instances.material.dispose();
    },
    ready: Promise.resolve(),
    scene,
    seek(timeMs: number) {
      elapsed = timeMs;
      focus.rotation.z = timeMs / 500;
      camera.lookAt(
        focus.position.clone().add(new Vector3(timeMs / 100, 0, 0))
      );
      camera.updateMatrixWorld(true);
    },
    settle() {
      elapsed = 1000;
      focus.rotation.z = 2;
      camera.lookAt(focus.position.clone().add(new Vector3(10, 0, 0)));
      camera.updateMatrixWorld(true);
    },
    targets: [
      {
        bounds: () => new Box3().setFromObject(focus),
        focus: () => focus.position.clone(),
        id: "semantic-focus",
        label: "Featured item",
        members: [{ object: focus }],
      },
    ],
    userData: {
      get elapsed() {
        return elapsed;
      },
    },
  };
}

export const createScene = createConfiguredScene;
