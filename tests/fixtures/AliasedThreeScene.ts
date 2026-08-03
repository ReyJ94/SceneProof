import { accentColor } from "sceneproof-test-three-accent";
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";

export function createScene() {
  const scene = new Scene();
  const subject = new Mesh(
    new BoxGeometry(1, 1, 1),
    new MeshBasicMaterial({ color: accentColor })
  );
  subject.name = "alias-subject";
  scene.add(subject);

  const camera = new PerspectiveCamera(45, 4 / 3, 0.1, 100);
  camera.position.set(0, 0, 4);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return { camera, scene };
}
