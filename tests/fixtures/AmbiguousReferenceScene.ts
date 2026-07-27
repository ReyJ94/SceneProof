import {
  CircleGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";

export function createScene(context: {
  readonly height: number;
  readonly width: number;
}) {
  const material = new MeshBasicMaterial({ color: "#d8c7ad" });
  const subject = new Group();
  subject.userData.sceneproofId = "subject";
  const left = new Mesh(new CircleGeometry(1, 48), material);
  left.position.x = -1.5;
  const right = new Mesh(new CircleGeometry(1, 48), material);
  right.position.x = 1.5;
  subject.add(left, right);
  const scene = new Scene();
  scene.background = new Color("#11111b");
  scene.add(subject);
  const camera = new PerspectiveCamera(
    40,
    context.width / context.height,
    0.1,
    100
  );
  camera.position.set(0, 0, 8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return { camera, scene };
}
