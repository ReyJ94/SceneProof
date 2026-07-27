import {
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Shape,
  ShapeGeometry,
} from "three";

export function createScene(context: {
  readonly height: number;
  readonly props?: { readonly brightness?: number; readonly jagged?: boolean };
  readonly width: number;
}) {
  const shape = new Shape();
  const segments = 64;
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    let radius = 1.5;
    if (context.props?.jagged) {
      radius = index % 2 === 0 ? 1.7 : 1.25;
    }
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (index === 0) {
      shape.moveTo(x, y);
    } else {
      shape.lineTo(x, y);
    }
  }
  shape.closePath();
  const subject = new Mesh(
    new ShapeGeometry(shape),
    new MeshBasicMaterial({
      color: new Color("#d8c7ad").multiplyScalar(
        context.props?.brightness ?? 1
      ),
    })
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
  camera.position.set(0, 0, 7);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return { camera, scene };
}
