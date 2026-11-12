import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

/**
 * Load a .vrm (0.x or 1.0) from a URL. three-vrm 3 reads both and exposes one
 * API; VRM 0.x presets are migrated to the 1.0 expression names:
 *   Blink->blink, BlinkL->blinkLeft, BlinkR->blinkRight,
 *   A/I/U/E/O -> aa/ih/ou/ee/oh, LookUp/Down/Left/Right -> lookUp/...
 */
export async function loadVRM(url) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('This file is not a VRM model.');

  // Cheap wins on an old iPad.
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons?.(gltf.scene);
  try {
    // Models with dozens of shape keys pay for every one of them on every vertex.
    // This keeps one morph per expression and drops the unused ones.
    VRMUtils.combineMorphs?.(vrm);
  } catch (err) {
    console.warn('[avatar] combineMorphs skipped:', err);
  }
  // VRM 0.x faces -Z; this turns it to face the camera. No-op for 1.0.
  VRMUtils.rotateVRM0(vrm);

  vrm.scene.traverse((o) => {
    o.frustumCulled = false; // skinned meshes often have bad bounds
  });

  // We drive the eyes ourselves (see tracking.js); never auto-aim at a target.
  if (vrm.lookAt) vrm.lookAt.autoUpdate = false;

  return vrm;
}

/** Rough check used for the UI: is this blendshape/expression bound on the model? */
export function hasExpression(vrm, name) {
  return !!vrm.expressionManager?.getExpression(name);
}

export function disposeVRM(vrm) {
  if (!vrm) return;
  vrm.scene.parent?.remove(vrm.scene);
  VRMUtils.deepDispose(vrm.scene);
}

export { THREE };
