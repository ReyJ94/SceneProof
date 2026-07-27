import {
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";

export function createScene(context: { height: number; width: number }) {
  const subject = new Mesh(
    new BoxGeometry(2, 4, 18),
    new MeshBasicMaterial({ color: "#d8c7ad" })
  );
  subject.userData.sceneproofId = "subject";
  const scene = new Scene();
  scene.background = new Color("#11111b");
  scene.add(subject);
  const camera = new PerspectiveCamera(
    40,
    context.width / context.height,
    0.1,
    100
  );
  camera.position.set(12, -16, 9);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return { camera, scene };
}
