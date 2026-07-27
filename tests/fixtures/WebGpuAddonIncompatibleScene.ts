import { PerspectiveCamera, Scene } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

export function createScene() {
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 4;

  // Importing this WebGL-only addon is the compatibility boundary under test.
  const material = new LineMaterial({ color: 0xff_aa_33 });
  material.dispose();

  return { camera, scene };
}
