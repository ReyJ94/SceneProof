import {
  BufferAttribute,
  BufferGeometry,
  Color,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
} from "three";

export function createScene(context: {
  readonly height: number;
  readonly width: number;
}) {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-1, 0, 0, 0, 1, 1, 1, 0, 0]), 3)
  );
  geometry.setAttribute(
    "aOpacity",
    new BufferAttribute(new Float32Array([0, 0, 0]), 1)
  );
  const material = new ShaderMaterial({
    fragmentShader: `
      varying float vOpacity;
      void main() {
        gl_FragColor = vec4(1.0, 1.0, 1.0, vOpacity);
      }
    `,
    transparent: true,
    uniforms: {
      uOpacity: { value: 0.5 },
      uTint: { value: new Color("#8d82ac") },
    },
    vertexShader: `
      attribute float aOpacity;
      varying float vOpacity;
      void main() {
        vOpacity = aOpacity;
        gl_PointSize = 3.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
  });
  const points = new Points(geometry, material);
  points.name = "Invisible point cloud";
  points.userData.uisceneId = "invisible-point-cloud";

  const scene = new Scene();
  scene.userData.uisceneId = "invisible-points-scene";
  scene.background = new Color("#080a12");
  scene.add(points);

  const camera = new PerspectiveCamera(
    42,
    context.width / context.height,
    0.1,
    100
  );
  camera.position.set(0, -8, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return { camera, scene };
}
