import * as THREE from 'three';

/**
 * Flat, unlit replacement for MToon: the cheapest material three.js can draw. It still
 * supports skinning and morph targets, so blendshape eyes and face tracking keep working.
 *
 * Each material carries an optional "effect" layer, driven only by uniforms (so changing
 * the layer, mask or mode never recompiles the shader):
 *
 *   base  = the material's colour texture (mesh UVs)
 *   layer = an image / animation drawn over it, in one of two modes:
 *             uMode 0  "UV"      the layer sticks to the model (sampled with the mesh UVs)
 *             uMode 1  "screen"  the spray look: sampled in window coordinates, so it stays
 *                                fixed to the screen while the avatar moves
 *   mask  = optional image on the mesh UVs (luminance 0..1) that says where the layer shows
 *   out   = mix(base, layer, mask * layer.alpha)
 */

// Shared so a resize only has to touch one object.
export const screenSize = new THREE.Vector2(1, 1);

let white = null;
/** 1x1 white texture: stands in for "no layer/mask", and gives colour-only materials a map (UVs) to use. */
export function whiteTexture() {
  if (!white) {
    white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.colorSpace = THREE.SRGBColorSpace;
    white.needsUpdate = true;
  }
  return white;
}

function makeFlat(original) {
  const m = new THREE.MeshBasicMaterial({
    map: original.map ?? null,
    color: original.map ? 0xffffff : (original.color ?? 0xffffff),
    side: original.side,
    transparent: original.transparent,
    alphaTest: original.alphaTest,
    depthWrite: original.depthWrite,
  });
  m.name = original.name;

  const fx = {
    uLayer: { value: whiteTexture() },
    uMask: { value: whiteTexture() },
    uRes: { value: screenSize },
    uEffect: { value: 0 },
    uMode: { value: 0 },
    uHasMask: { value: 0 },
  };
  m.userData.fx = fx;

  m.onBeforeCompile = (shader) => {
    if (!m.map) return; // no UVs without a map; the effect needs one (see textures.js)
    Object.assign(shader.uniforms, fx);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uLayer;
         uniform sampler2D uMask;
         uniform vec2 uRes;
         uniform float uEffect;
         uniform float uMode;
         uniform float uHasMask;`
      )
      .replace(
        '#include <map_fragment>',
        `vec4 baseS = texture2D( map, vMapUv );
         vec3 col = baseS.rgb;
         if ( uEffect > 0.5 ) {
           // gl_FragCoord has y up; the layer is stored with v down, so flip it for screen mode.
           vec2 layerUv = uMode > 0.5 ? vec2( gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y ) : vMapUv;
           vec4 layer = texture2D( uLayer, layerUv );
           float k = uHasMask > 0.5
             ? clamp( dot( texture2D( uMask, vMapUv ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0, 1.0 )
             : 1.0;
           col = mix( col, layer.rgb, k * layer.a );
         }
         diffuseColor.rgb *= col;
         diffuseColor.a *= baseS.a;`
      );
  };
  m.customProgramCacheKey = () => (m.map ? 'flat-fx-v2' : 'flat-plain');
  return m;
}

/** Swap every MToon material on the avatar for a flat one. */
export function applyFlatShading(vrm) {
  const disposed = new Set();

  vrm.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const isArray = Array.isArray(obj.material);
    const mats = isArray ? obj.material : [obj.material];

    const next = mats.map((orig) => {
      // MToon outlines are extra materials on the same geometry: skip drawing them.
      if (orig.isOutline) {
        orig.visible = false;
        return orig;
      }
      disposed.add(orig);
      return makeFlat(orig);
    });

    obj.material = isArray ? next : next[0];
  });

  disposed.forEach((m) => m.dispose?.());
}
