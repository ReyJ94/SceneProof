import {
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";

export function createScene() {
  const scene = new Scene();
  scene.name = "webgpu-standard-scene";
  scene.background = new Color("#090b12");

  const subject = new Mesh(
    new BoxGeometry(1.4, 1.4, 1.4),
    new MeshBasicMaterial({ color: "#55aaff" })
  );
  subject.name = "webgpu-subject";
  scene.add(subject);

  const camera = new PerspectiveCamera(40, 4 / 3, 0.1, 100);
  camera.position.set(0, 0, 4);

  return { camera, scene };
}
