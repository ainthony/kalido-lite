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

## Layout

- **Bottom-right blob:** camera on/off, choose a `.vrm` model, background colour.
- **Right rail:** info, settings (gear), textures (shirt), hide interface (eye). Hidden controls return while you hover (or tap) the right edge or bottom-right corner. There is no camera preview.
- **Settings (right panel):** tracking, camera (choose camera, calibrate face position), expressions (choose which are auto-detected), performance, view (turn, tilt, zoom, move), "if something moves backwards".
- **Textures (left panel):** every texture on the model, listed by name.

## Texture panel

Each row is one texture (all materials sharing it, plus the meshes that use it). Tap a row to expand it.

- **Hide** (eye button on the row): hides the texture *and the 3D parts that use it*.
- **Replace texture:** swap it for another image, animation or video.
- **Texture effects:** an extra layer over the texture.
  - **Spray (screen):** the layer is fixed to the screen, so the avatar moves "through" it.
  - **Follow UV:** the layer sticks to the model using its UV map.
  - **Add texture** is the layer; **Mask** (optional) is a black/white image on the model's UVs saying where the layer shows.
- Replace and Add texture accept still images, **GIF, APNG, animated WebP, MP4 and WebM**.
  Use MP4 or GIF on older iPads; animations above 512 px are scaled down, and very long ones are cut to save memory.
  Animated WebP needs WebCodecs (Chrome, Edge); Safari 16 falls back to a best-effort mode that may look frozen.
- A replaced image with transparent pixels cuts through the model (hard edge).
- Everything is remembered per model (by file name and size) on the device.

## Preparing your avatar

1. In Blender (VRM add-on), bind your stylised eye shape keys to the `LookUp / LookDown / LookLeft / LookRight` presets and set **Look At Type** to **BlendShape**. Bind `Blink` (or `Blink_L` / `Blink_R`), and `A I U E O` for the mouth.
2. Export as `.vrm`.
3. Load it with the person button (bottom right), or drag and drop.

`.vsfavatar` files are Unity asset bundles and cannot run in a browser. The loader detects them and explains how to export VRM instead.

## Things to verify with your own model

I could not test with a real avatar or camera while building this, so check these first:

- **Directions.** If the head, blink or eyes move backwards, use the checkboxes under "If something moves backwards" (they persist).
- **Eye range.** Eye weight is scaled by the model's own look-at range map. If the eyes barely move, widen the range in the VRM add-on.
- **Spray orientation.** Screen-mode layers are drawn upright; if yours looks flipped, flip the `1.0 - gl_FragCoord.y / uRes.y` term in `src/flatMaterial.js`.

## Performance notes (iPad Pro 9.7")

Antialiasing is off, pixel ratio is capped at 1.5, outlines are skipped, and only one material per mesh is drawn. If it still stutters, lower the camera resolution in `src/main.js` or reduce model polygons/materials.

## Licence

Your code is yours to license. Dependencies: three.js (MIT), @pixiv/three-vrm (MIT), Kalidokit (MIT), MediaPipe (Apache-2.0).
