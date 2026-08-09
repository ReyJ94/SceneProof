import {
  AmbientLight,
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";

import { defineThreeFixture } from "../../src/three-fixture.js";

export const createEffectComposerScene = defineThreeFixture(
  ({ height, props, width }) => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 0, 4);
    const subject = new Mesh(
      new BoxGeometry(1.5, 1.5, 1.5),
      new MeshStandardMaterial({ color: 0x2d_d4_bf })
    );
    subject.name = "composer-subject";
    scene.add(subject, new AmbientLight(0xff_ff_ff, 3));

    const renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    const render = renderer.render.bind(renderer);
    renderer.render = ((...args: Parameters<WebGLRenderer["render"]>) => {
      const drawCount = Number(scene.userData.drawCount ?? 0) + 1;
      scene.userData.drawCount = drawCount;
      if (drawCount > 1) {
        throw new Error("SceneProof rendered after the fixture draw");
      }
      return render(...args);
    }) as WebGLRenderer["render"];
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    return {
      camera,
      dispose() {
        composer.dispose();
        subject.geometry.dispose();
        subject.material.dispose();
      },
      draw({ viewport }) {
        scene.userData.drawViewport = viewport;
        if (props.throwDraw === true) {
          throw new Error("fixture draw failed deliberately");
        }
        composer.setSize(viewport.pixelWidth, viewport.pixelHeight);
        composer.render();
      },
      renderer,
      scene,
      targets: [{ id: "composer-subject", members: [{ object: subject }] }],
    };
  }
);
