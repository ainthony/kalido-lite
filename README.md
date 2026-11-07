# Kalidoface Lite

A small webcam VTuber viewer for older iPads. It does three things the original Kalidoface 3D doesn't:

- **VRM 0.x and 1.0** via `@pixiv/three-vrm` 3.x (the original is on 0.6 and VRM 0.x only).
- **Flat, unlit shading** (no MToon), with an optional `mix(base, spray, mask)` layer that reproduces a Blender node graph: base colour on mesh UVs, a spray texture in screen space, and a mask texture driving the mix.
- **Blendshape eyes** (`lookUp/Down/Left/Right` + `blink`) instead of eye bones.

Tracking is face-only (MediaPipe FaceLandmarker + Kalidokit) to keep it light. Everything runs in the browser; models and textures are stored on-device in IndexedDB.

## Why not a literal fork?

`yeemachine/kalidoface-3d` only publishes the minified build (its `src/` is gitignored), so there is no readable source to migrate. This project reuses the same ingredients (Kalidokit, three-vrm, MediaPipe) in a fresh, small codebase.

## Run

```bash
npm install
npm run dev      # https://localhost works for the camera; for a tablet use the deployed Pages URL
npm run build
```

Deploy: push to `main` with GitHub Pages set to "GitHub Actions" (Settings -> Pages). The workflow in `.github/workflows/pages.yml` builds and publishes. Camera access needs HTTPS, which Pages provides.

## Preparing your avatar

1. In Blender (VRM add-on), bind your stylised eye shape keys to the `LookUp / LookDown / LookLeft / LookRight` presets and set **Look At Type** to **BlendShape**. Bind `Blink` (or `Blink_L` / `Blink_R`), and `A I U E O` for the mouth.
2. Export as `.vrm`.
3. Load it from the side panel (or drag and drop).
4. Optional: load your **spray** and **mask** images. "Apply mix to materials matching" is a regex on material names, e.g. `body|skin`; blank means every textured material.

`.vsfavatar` files are Unity asset bundles and cannot run in a browser. The loader detects them and explains how to export VRM instead.

## Things to verify with your own model

I could not test with a real avatar or camera while building this, so check these first:

- **Directions.** If the head, blink or eyes move backwards, use the checkboxes under "If something moves backwards" (they persist).
- **Eye range.** Eye weight is scaled by the model's own look-at range map. If the eyes barely move, widen the range in the VRM add-on.
- **Spray orientation.** If the spray layer is upside down, flip `flipY` for the spray texture in `src/flatMaterial.js`.

## Performance notes (iPad Pro 9.7")

Antialiasing is off, pixel ratio is capped at 1.5, outlines are skipped, and only one material per mesh is drawn. If it still stutters, lower the camera resolution in `src/main.js` or reduce model polygons/materials.

## Licence

Your code is yours to license. Dependencies: three.js (MIT), @pixiv/three-vrm (MIT), Kalidokit (MIT), MediaPipe (Apache-2.0).
