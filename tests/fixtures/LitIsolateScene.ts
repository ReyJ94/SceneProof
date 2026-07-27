import {
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
} from "three";

export function createScene(context: {
  readonly height: number;
  readonly width: number;
}) {
  const scene = new Scene();
  scene.background = new Color("#050509");
  scene.userData.sceneproofId = "lit-isolate-scene";

  const subject = new Mesh(
    new BoxGeometry(2, 2, 2),
    new MeshStandardMaterial({ color: "#d8c7ad", roughness: 0.65 })
  );
  subject.userData.sceneproofId = "subject";
  scene.add(subject);

  const contextPlane = new Mesh(
    new BoxGeometry(8, 0.25, 5),
    new MeshStandardMaterial({ color: "#31384a", roughness: 0.9 })
  );
  contextPlane.position.set(0, 1.8, -0.8);
  contextPlane.userData.sceneproofId = "context-plane";
  scene.add(contextPlane);

  const key = new DirectionalLight("#ffffff", 3);
  key.name = "Key light";
  key.userData.sceneproofId = "key-light";
  key.position.set(2, -3, 4);
  key.target.position.set(0, 0, 0);
  scene.add(key, key.target);

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
    camera,
    scene,
    targets: [
      {
        bounds: () => new Box3().setFromObject(subject),
        context: [{ object: contextPlane }],
        id: "subject",
        isolate: () => {
          scene.traverse((object) => {
            object.visible = object === scene || object === subject;
          });
        },
        members: [{ object: subject }],
      },
    ],
  };
}
