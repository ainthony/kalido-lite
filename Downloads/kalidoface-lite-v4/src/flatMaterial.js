import * as THREE from 'three';

/**
 * Flat, unlit replacement for MToon. Reproduces the Blender node graph:
 *
 *   base  = base-color texture (the model's own map, mesh UVs)
 *   spray = spray texture sampled in *window* coordinates (screen space)
 *   mask  = mask texture on mesh UVs, converted to a 0..1 factor (luminance)
 *   out   = mix(base, spray, mask)
 *
 * MeshBasicMaterial ignores lights, so this is the cheapest material three.js
 * can draw. It still supports skinning and morph targets, so blendshape eyes
 * and face tracking keep working.
 */

// Shared so a resize only has to touch one object.
export const screenSize = new THREE.Vector2(1, 1);

export function loadLayerTexture(url, { flipY }) {
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = THREE.SRGBColorSpace; // Blender graph uses sRGB for both
  tex.flipY = flipY;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 2; // cheap on an A9X
  return tex;
}

/** Spray is looked up by screen position: Blender image space (origin bottom-left) => flipY true. */
export const loadSprayTexture = (url) => loadLayerTexture(url, { flipY: true });
/** Mask uses glTF mesh UVs (v down) => flipY false. */
export const loadMaskTexture = (url) => loadLayerTexture(url, { flipY: false });

function makeBasic(original, extra = {}) {
  const m = new THREE.MeshBasicMaterial({
    map: original.map ?? null,
    color: original.map ? 0xffffff : (original.color ?? 0xffffff),
    side: original.side,
    transparent: original.transparent,
    alphaTest: original.alphaTest,
    depthWrite: original.depthWrite,
    ...extra,
  });
  m.name = original.name;
  return m;
}

function makeMixed(original, spray, mask) {
  const m = makeBasic(original);
  const uniforms = {
    uSpray: { value: spray },
    uMask: { value: mask },
    uRes: { value: screenSize },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uSpray;
         uniform sampler2D uMask;
         uniform vec2 uRes;`
      )
      .replace(
        '#include <map_fragment>',
        `vec4 baseS = texture2D( map, vMapUv );
         vec3 sprayC = texture2D( uSpray, gl_FragCoord.xy / uRes ).rgb;
         float maskF = clamp( dot( texture2D( uMask, vMapUv ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0, 1.0 );
         diffuseColor.rgb *= mix( baseS.rgb, sprayC, maskF );
         diffuseColor.a *= baseS.a;`
      );
  };
  m.customProgramCacheKey = () => 'flat-spray-mask';
  return m;
}

/**
 * Swap every MToon material on the avatar for a flat one.
 *
 * @param vrm       loaded VRM
 * @param opts.spray / opts.mask  textures (both required to enable the mix)
 * @param opts.target  RegExp: only materials whose name matches get the spray/mask mix.
 *                     Others (eyes, mouth, brows...) become plain unlit materials.
 */
export function applyFlatShading(vrm, { spray = null, mask = null, target = null } = {}) {
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
      const wantsMix = spray && mask && orig.map && (!target || target.test(orig.name));
      const flat = wantsMix ? makeMixed(orig, spray, mask) : makeBasic(orig);
      disposed.add(orig);
      return flat;
    });

    obj.material = isArray ? next : next[0];
  });

  disposed.forEach((m) => m.dispose?.());
}
