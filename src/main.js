import * as THREE from 'three';
import { loadVRM, disposeVRM } from './avatar.js';
import {
  applyFlatShading,
  loadSprayTexture,
  loadMaskTexture,
  screenSize,
} from './flatMaterial.js';
import {
  Tracker,
  applyFaceRig,
  applyPoseRig,
  applyHandRigs,
  relaxFace,
  restBody,
  relaxHands,
  settings,
} from './tracking.js';
import { saveFile, loadFile, removeFile, loadPrefs, savePrefs } from './storage.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const STALE_MS = 500; // treat a tracker as "lost" after this long without a result

// ---------------------------------------------------------------- prefs ----
const DEFAULT_VIEW = { yaw: 0, x: 0, y: 0, zoom: 1 };
const prefs = loadPrefs({
  v: 3,
  bg: '#00b140', // chroma green for OBS-style keying
  target: '',    // regex of material names that get the spray/mask mix ('' = all with a texture)
  view: { ...DEFAULT_VIEW },
  ...settings,
});
// v3 changed what "mirror" means and added body/hand settings: drop stale direction flags.
if (prefs.v !== 3) {
  for (const k of ['mirror', 'swapBlink', 'swapHands', 'flipEyeX', 'flipEyeY', 'body', 'hands']) {
    prefs[k] = settings[k];
  }
  prefs.v = 3;
}
Object.keys(settings).forEach((k) => (settings[k] = prefs[k]));
const view = { ...DEFAULT_VIEW, ...prefs.view };
const persist = () => savePrefs({ ...prefs, ...settings, view });

// ------------------------------------------------------------- renderer ----
const canvas = $('stage');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,                 // big saver on an A9X; the flat style hides it well
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
camera.position.set(0, 1.35, 1.0);
let camDist = 1.0;

// The avatar lives in a root group so user rotation/position never fights the
// rotation three-vrm applies to the VRM scene itself.
const avatarRoot = new THREE.Group();
scene.add(avatarRoot);

const setBackground = (hex) => {
  scene.background = new THREE.Color(hex);
  document.body.style.background = hex;
};
setBackground(prefs.bg);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(screenSize); // spray layer is sampled in window coords
}
window.addEventListener('resize', resize);
resize();

// ----------------------------------------------------------- view control ----
const TAU = Math.PI * 2;
const wrap = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

const sliders = {
  yaw: $('view-yaw'),
  zoom: $('view-zoom'),
  x: $('view-x'),
  y: $('view-y'),
};

function applyView() {
  view.yaw = wrap(view.yaw);
  view.zoom = THREE.MathUtils.clamp(view.zoom, 0.25, 6);
  view.x = THREE.MathUtils.clamp(view.x, -3, 3);
  view.y = THREE.MathUtils.clamp(view.y, -3, 3);
  avatarRoot.rotation.y = view.yaw;
  avatarRoot.position.set(view.x, view.y, 0);
  camera.zoom = view.zoom;
  camera.updateProjectionMatrix();
  sliders.yaw.value = THREE.MathUtils.radToDeg(view.yaw);
  sliders.zoom.value = view.zoom;
  sliders.x.value = view.x;
  sliders.y.value = view.y;
}
applyView();

sliders.yaw.addEventListener('input', () => { view.yaw = THREE.MathUtils.degToRad(+sliders.yaw.value); applyView(); });
sliders.zoom.addEventListener('input', () => { view.zoom = +sliders.zoom.value; applyView(); });
sliders.x.addEventListener('input', () => { view.x = +sliders.x.value; applyView(); });
sliders.y.addEventListener('input', () => { view.y = +sliders.y.value; applyView(); });
for (const s of Object.values(sliders)) s.addEventListener('change', persist);

function resetView() {
  Object.assign(view, DEFAULT_VIEW);
  applyView();
  persist();
}
$('reset-view').addEventListener('click', resetView);
canvas.addEventListener('dblclick', resetView);

// World units per screen pixel at the avatar's distance.
function worldPerPixel() {
  const h = 2 * camDist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.zoom;
  return h / window.innerHeight;
}
function pan(dx, dy) {
  const k = worldPerPixel();
  view.x += dx * k;
  view.y -= dy * k;
}

// One finger / left mouse: rotate. Two fingers: pinch to zoom + drag to move.
// Mouse: right-drag or Shift-drag moves, wheel zooms.
const pointers = new Map();
let pinch = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinch = null;
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;

  if (pointers.size === 1) {
    if (e.buttons & 2 || e.shiftKey) pan(dx, dy);
    else view.yaw += dx * 0.008;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (pinch && pinch.dist > 0) {
      view.zoom *= dist / pinch.dist;
      pan(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
    }
    pinch = { dist, mid };
  }
  applyView();
});
const endPointer = (e) => {
  if (!pointers.delete(e.pointerId)) return;
  pinch = null;
  persist();
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    view.zoom *= Math.exp(-e.deltaY * 0.0015);
    applyView();
    persist();
  },
  { passive: false }
);

// ------------------------------------------------------------- messages ----
const toastEl = $('toast');
let toastTimer;
function toast(msg, ms = 4000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

// --------------------------------------------------------------- avatar ----
let vrm = null;
let sprayTex = null;
let maskTex = null;
const objectUrls = [];
const urlFor = (file) => {
  const u = URL.createObjectURL(file);
  objectUrls.push(u);
  return u;
};

/** What kind of file is this really? (Extensions lie; headers don't.) */
async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const text = String.fromCharCode(...head);
  if (text.startsWith('glTF')) return 'glb';
  if (text.startsWith('UnityFS') || /\.vsfavatar$/i.test(file.name)) return 'unity';
  return 'unknown';
}

const VSF_HELP =
  'VSFAvatar is a Unity asset bundle and can\'t run in a browser. Export it as VRM 1.0 from Unity (UniVRM), or use the VRM add-on in Blender, then load the .vrm here.';

function frameAvatar() {
  const head = vrm.humanoid?.getNormalizedBoneNode('head');
  const y = head ? head.getWorldPosition(new THREE.Vector3()).y : 1.4;
  // Frame head and shoulders; use the zoom/move controls for anything else.
  camDist = THREE.MathUtils.clamp(y * 0.6, 0.45, 1.4);
  camera.position.set(0, y + 0.02, camDist);
  camera.lookAt(0, y - 0.04, 0);
}

async function rebuildAvatar() {
  const stored = await loadFile('vrm');
  if (!stored) {
    $('hint').hidden = false;
    return;
  }
  $('hint').hidden = true;
  toast('Loading model…', 0);
  try {
    const next = await loadVRM(urlFor(stored));
    if (vrm) {
      avatarRoot.remove(vrm.scene);
      disposeVRM(vrm);
    }
    vrm = next;
    applyFlatShading(vrm, {
      spray: sprayTex,
      mask: maskTex,
      target: prefs.target ? new RegExp(prefs.target, 'i') : null,
    });
    avatarRoot.add(vrm.scene);
    restBody(vrm, 1); // snap straight to arms-down instead of the T-pose
    frameAvatar();

    const em = vrm.expressionManager;
    const eyeMode = vrm.lookAt?.applier?.type ?? 'none';
    const missing = ['blink', 'aa', 'lookUp', 'lookLeft'].filter((n) => !em?.getExpression(n));
    toast(
      `Loaded (VRM ${vrm.meta?.metaVersion ?? '?'}). Eyes: ${eyeMode}` +
        (eyeMode === 'bone' ? ' (set Look At to BlendShape in Blender for blendshape eyes)' : '') +
        (missing.length ? ` · missing: ${missing.join(', ')}` : ''),
      6000
    );
  } catch (err) {
    console.error(err);
    toast(`Couldn't load model: ${err.message}`, 8000);
  }
}

async function rebuildTextures() {
  sprayTex?.dispose();
  maskTex?.dispose();
  sprayTex = maskTex = null;
  const [spray, mask] = await Promise.all([loadFile('spray'), loadFile('mask')]);
  if (spray) sprayTex = loadSprayTexture(urlFor(spray));
  if (mask) maskTex = loadMaskTexture(urlFor(mask));
}

async function onModelPicked(file) {
  const kind = await sniff(file);
  if (kind === 'unity') return toast(VSF_HELP, 12000);
  if (kind !== 'glb') return toast('That doesn\'t look like a .vrm file.', 6000);
  await saveFile('vrm', file);
  await rebuildAvatar();
}

async function onTexturePicked(key, file) {
  await saveFile(key, file);
  await rebuildTextures();
  await rebuildAvatar();
}

// ------------------------------------------------------------------ UI ----
$('pick-vrm').addEventListener('change', (e) => e.target.files[0] && onModelPicked(e.target.files[0]));
$('pick-spray').addEventListener('change', (e) => e.target.files[0] && onTexturePicked('spray', e.target.files[0]));
$('pick-mask').addEventListener('change', (e) => e.target.files[0] && onTexturePicked('mask', e.target.files[0]));
$('clear-tex').addEventListener('click', async () => {
  await Promise.all([removeFile('spray'), removeFile('mask')]);
  await rebuildTextures();
  await rebuildAvatar();
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) onModelPicked(f);
});

$('bg').value = prefs.bg;
$('bg').addEventListener('input', (e) => {
  prefs.bg = e.target.value;
  setBackground(prefs.bg);
  persist();
});

$('target').value = prefs.target;
$('target').addEventListener('change', async (e) => {
  prefs.target = e.target.value.trim();
  persist();
  await rebuildAvatar();
});

for (const key of ['mirror', 'swapBlink', 'swapHands', 'flipEyeX', 'flipEyeY']) {
  const box = $(key);
  box.checked = !!settings[key];
  box.addEventListener('change', () => {
    settings[key] = box.checked;
    persist();
  });
}

$('toggle-ui').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

// --------------------------------------------------------------- camera ----
const video = $('cam');
let tracker = null;
let tracking = false;

async function syncOptionalTrackers() {
  if (!tracker) return;
  try {
    if (settings.body) await tracker.enablePose();
    else tracker.disablePose();
    if (settings.hands) await tracker.enableHands();
    else tracker.disableHands();
  } catch (err) {
    console.error(err);
    toast(`Couldn't start body/hand tracking: ${err.message}`, 8000);
  }
}

for (const key of ['body', 'hands']) {
  const box = $(key);
  box.checked = !!settings[key];
  box.addEventListener('change', async () => {
    settings[key] = box.checked;
    persist();
    if (tracker) {
      toast(box.checked ? 'Loading tracker…' : 'Tracker off.', box.checked ? 0 : 2000);
      await syncOptionalTrackers();
      if (box.checked) toast('Ready.');
    }
  });
}

async function startCamera() {
  $('start').disabled = true;
  toast('Starting camera and tracking…', 0);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    tracker ??= await Tracker.create();
    await syncOptionalTrackers();
    tracking = true;
    $('start').textContent = 'Camera on';
    toast('Tracking started.');
  } catch (err) {
    console.error(err);
    $('start').disabled = false;
    toast(`Couldn't start tracking: ${err.message}`, 8000);
  }
}
$('start').addEventListener('click', startCamera);
$('preview').addEventListener('change', (e) => video.classList.toggle('show', e.target.checked));

// ----------------------------------------------------------------- loop ----
const clock = new THREE.Clock();
let frames = 0;
let fpsAt = performance.now();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();

  if (vrm) {
    if (tracking && tracker) {
      tracker.update(video);

      // Face
      if (now - tracker.faceAt < STALE_MS) applyFaceRig(vrm, tracker.face);
      else relaxFace(vrm);

      // Body: tracked arms/torso when available, otherwise the arms-down rest pose.
      if (settings.body && tracker.pose && now - tracker.poseAt < STALE_MS) {
        applyPoseRig(vrm, tracker.pose);
      } else {
        restBody(vrm);
      }

      // Fingers
      if (settings.hands && tracker.handLm && now - tracker.handsAt < STALE_MS) {
        applyHandRigs(vrm, tracker.hands, tracker.pose);
      } else {
        relaxHands(vrm);
      }
    } else {
      relaxFace(vrm);
      restBody(vrm);
      relaxHands(vrm);
    }
    vrm.update(dt); // applies look-at -> expressions, spring bones, etc.
  }
  renderer.render(scene, camera);

  frames++;
  if (now - fpsAt > 1000) {
    $('fps').textContent = `${Math.round((frames * 1000) / (now - fpsAt))} fps`;
    frames = 0;
    fpsAt = now;
  }
});

// ----------------------------------------------------------------- boot ----
(async () => {
  await rebuildTextures();
  await rebuildAvatar();
})();
