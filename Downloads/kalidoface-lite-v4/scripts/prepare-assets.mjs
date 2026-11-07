// Runs before dev/build.
//  1. Copies MediaPipe's WASM runtime out of node_modules so the site is self-hosted
//     (no CDN dependency for the runtime; important for flaky tablet connections).
//  2. Downloads the face, pose and hand models into public/models if they aren't there yet.
//     If the download fails, the app falls back to Google's hosted copy at runtime.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = resolve(root, 'public/mediapipe/wasm');
mkdirSync(wasmDst, { recursive: true });
cpSync(wasmSrc, wasmDst, { recursive: true });
console.log('[assets] copied MediaPipe wasm ->', wasmDst);

const BASE = 'https://storage.googleapis.com/mediapipe-models';
const models = {
  'face_landmarker.task': `${BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  'pose_landmarker_lite.task': `${BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  'hand_landmarker.task': `${BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
};

mkdirSync(resolve(root, 'public/models'), { recursive: true });
for (const [file, url] of Object.entries(models)) {
  const dest = resolve(root, 'public/models', file);
  if (existsSync(dest)) continue;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`[assets] downloaded ${file}`);
  } catch (err) {
    console.warn(`[assets] ${file} download skipped (${err.message}); the app will use the hosted copy at runtime.`);
  }
}
