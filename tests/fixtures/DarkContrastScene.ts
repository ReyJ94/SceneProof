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
  scene.background = new Color("#11111b");
  const subject = new Mesh(
    new BoxGeometry(2.5, 2.5, 2.5),
    new MeshBasicMaterial({ color: "#12121c" })
  );
  subject.userData.sceneproofId = "subject";
  scene.add(subject);

  const camera = new PerspectiveCamera(
    40,
    context.width / context.height,
    0.1,
    100
  );
  camera.position.set(5, -7, 4);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return {
    camera,
    scene,
    targets: [
      {
        bounds: () => new Box3().setFromObject(subject),
        id: "subject",
        members: [{ object: subject }],
      },
    ],
  };
}
