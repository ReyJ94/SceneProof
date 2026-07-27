import {
  Box3,
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";

export function createScene(context: {
  readonly height: number;
  readonly width: number;
}) {
  const scene = new Scene();
  scene.background = new Color("#080a12");
  const subject = new Mesh(
    new BoxGeometry(2, 2, 2),
    new MeshBasicMaterial({ color: "#f2a65a" })
  );
  subject.userData.sceneproofId = "subject";
  scene.add(subject);

  const camera = new PerspectiveCamera(
    38,
    context.width / context.height,
    0.1,
    100
  );
  camera.position.set(5, -7, 4);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return {
    actions: {
      select() {
        // Intentional no-op: this fixture proves null transitions are detected.
      },
    },
    camera,
    scene,
    seek() {
      // Intentional no-op: time samples remain pixel-identical.
    },
    settle() {
      // Intentional no-op: settled state remains pixel-identical.
    },
    targets: [
      {
        bounds: () => new Box3().setFromObject(subject),
        id: "subject",
        members: [{ object: subject }],
      },
    ],
  };
}
