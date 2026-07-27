import {
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
} from "three";

export function createScene() {
  const scene = new Scene();
  scene.name = "webgpu-incompatible-scene";

  const subject = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      fragmentShader: `
        void main() {
          gl_FragColor = vec4(0.2, 0.7, 1.0, 1.0);
        }
      `,
      vertexShader: `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
    })
  );
  subject.name = "glsl-subject";
  scene.add(subject);

  const camera = new PerspectiveCamera(40, 4 / 3, 0.1, 100);
  camera.position.z = 4;

  return { camera, scene };
}
