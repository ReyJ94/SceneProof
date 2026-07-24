import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  TorusGeometry,
} from "three";

type SceneContext = {
  readonly height: number;
  readonly pixelRatio: number;
  readonly width: number;
};

export function createScene(context: SceneContext) {
  const scene = new Scene();
  scene.name = "Object gallery";
  scene.userData.sceneproofId = "object-gallery";
  scene.background = new Color("#080a12");

  const concepts = new Group();
  concepts.name = "Concepts";
  concepts.userData.sceneproofId = "collection";

  const earth = new Mesh(
    new SphereGeometry(1.2, 64, 48),
    new MeshStandardMaterial({
      color: "#74c7ec",
      metalness: 0.15,
      roughness: 0.38,
    })
  );
  earth.name = "Earth";
  earth.userData.sceneproofId = "featured-model";
  earth.position.set(-2.4, 0.2, 0);

  const reason = new Mesh(
    new TorusGeometry(1, 0.28, 32, 96),
    new MeshStandardMaterial({
      color: "#b08d57",
      metalness: 0.42,
      roughness: 0.3,
    })
  );
  reason.name = "Reason";
  reason.userData.sceneproofId = "concept-reason";
  reason.position.set(0.4, 0.15, 0);
  reason.rotation.x = Math.PI / 3;

  const evidence = new Mesh(
    new BoxGeometry(1.7, 1.7, 1.7, 4, 4, 4),
    new MeshStandardMaterial({
      color: "#cdd6f4",
      metalness: 0.08,
      roughness: 0.52,
    })
  );
  evidence.name = "Evidence";
  evidence.userData.sceneproofId = "concept-evidence";
  evidence.position.set(3, -0.1, 0);
  evidence.rotation.set(0.35, 0.55, 0.1);

  concepts.add(earth, reason, evidence);
  scene.add(
    concepts,
    new AmbientLight("#756c9b", 1.3),
    new DirectionalLight("#f2eadf", 2.1)
  );
  const key = scene.children.at(-1);
  key?.position.set(-4, 7, 6);

  const camera = new PerspectiveCamera(
    42,
    context.width / context.height,
    0.1,
    100
  );
  camera.name = "Knowledge camera";
  camera.position.set(0, 3.2, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return {
    camera,
    dispose: () => {
      concepts.traverse((object) => {
        if (!(object instanceof Mesh)) {
          return;
        }
        object.geometry.dispose();
        if (Array.isArray(object.material)) {
          for (const material of object.material) {
            material.dispose();
          }
        } else {
          object.material.dispose();
        }
      });
    },
    scene,
  };
}
