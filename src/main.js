import * as THREE from 'three';
import { loadVRM, disposeVRM } from './avatar.js';
import { applyFlatShading, screenSize } from './flatMaterial.js';
import { TextureManager } from './textures.js';
import { initTexturePanel } from './texturePanel.js';
import { hydrateIcons } from './icons.js';
import {
  Tracker,
  applyFaceRig,
  applyPoseRig,
  applyHandRigs,
  applyExpressions,
  startExpressionCalibration,
  startPositionCalibration,
  resetPositionCalibration,
  updatePositionCalibration,
  isPositionCalibrated,
  PERF,
  LEVELS,
  relaxFace,
  restBody,
  relaxHands,
  settings,
} from './tracking.js';
import { saveFile, loadFile, loadPrefs, savePrefs } from './storage.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const STALE_MS = 500; // treat a tracker as "lost" after this long without a result

// ---------------------------------------------------------------- prefs ----
const DEFAULT_VIEW = { yaw: 0, pitch: 0, x: 0, y: 0, zoom: 1 };
const prefs = loadPrefs({
  v: 3,
  bg: '#00b140', // chroma green for OBS-style keying
  view: { ...DEFAULT_VIEW },
  ...settings,
});
if (!prefs.exprEnabled || typeof prefs.exprEnabled !== 'object') prefs.exprEnabled = { ...settings.exprEnabled };
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
// Render resolution follows the performance level (see applyPerf below).
let level = prefs.perf === 'auto' || !PERF[prefs.perf] ? 'balanced' : prefs.perf;
const setRatio = () => renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PERF[level].ratio));
setRatio();
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
camera.position.set(0, 1.35, 1.0);
let camDist = 1.0;
let vrm = null;
let pivotY = 1.3; // the avatar turns and tilts around its head height, not its feet

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
const PITCH_MAX = THREE.MathUtils.degToRad(80);
const wrap = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

const sliders = {
  yaw: $('view-yaw'),
  pitch: $('view-pitch'),
  zoom: $('view-zoom'),
  x: $('view-x'),
  y: $('view-y'),
};

function applyView() {
  view.yaw = wrap(view.yaw);
  view.pitch = THREE.MathUtils.clamp(view.pitch, -PITCH_MAX, PITCH_MAX);
  view.zoom = THREE.MathUtils.clamp(view.zoom, 0.25, 6);
  view.x = THREE.MathUtils.clamp(view.x, -3, 3);
  view.y = THREE.MathUtils.clamp(view.y, -3, 3);
  avatarRoot.rotation.set(view.pitch, view.yaw, 0); // turn about the avatar's own up axis, then tilt
  avatarRoot.position.set(view.x, pivotY + view.y, 0);
  if (vrm) vrm.scene.position.y = -pivotY;
  camera.zoom = view.zoom;
  camera.updateProjectionMatrix();
  sliders.yaw.value = THREE.MathUtils.radToDeg(view.yaw);
  sliders.pitch.value = THREE.MathUtils.radToDeg(view.pitch);
  sliders.zoom.value = view.zoom;
  sliders.x.value = view.x;
  sliders.y.value = view.y;
}
applyView();

sliders.yaw.addEventListener('input', () => { view.yaw = THREE.MathUtils.degToRad(+sliders.yaw.value); applyView(); });
sliders.pitch.addEventListener('input', () => { view.pitch = THREE.MathUtils.degToRad(+sliders.pitch.value); applyView(); });
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
    else {
      view.yaw += dx * 0.008;   // drag sideways: turn
      view.pitch += dy * 0.006; // drag up/down: tilt
    }
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
const textures = new TextureManager();
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
  // Measure with the root transform cleared, so the user's view offset doesn't leak into the framing.
  avatarRoot.position.set(0, 0, 0);
  avatarRoot.rotation.set(0, 0, 0);
  vrm.scene.position.y = 0;
  avatarRoot.updateMatrixWorld(true);
  const head = vrm.humanoid?.getNormalizedBoneNode('head');
  const y = head ? head.getWorldPosition(new THREE.Vector3()).y : 1.4;
  // Frame head and shoulders; use the zoom/move controls for anything else.
  pivotY = y;
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
    applyFlatShading(vrm);
    avatarRoot.add(vrm.scene);
    // Re-applies this model's saved hide/replace/effect choices in the background.
    textures.attach(vrm, `${stored.name}|${stored.size}`).catch((err) => console.error('[textures]', err));
    restBody(vrm, 1); // snap straight to arms-down instead of the T-pose
    frameAvatar();
    applyView();

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

async function onModelPicked(file) {
  const kind = await sniff(file);
  if (kind === 'unity') return toast(VSF_HELP, 12000);
  if (kind !== 'glb') return toast('That doesn\'t look like a .vrm file.', 6000);
  await saveFile('vrm', file);
  await rebuildAvatar();
}

// ------------------------------------------------------------------ UI ----
$('pick-vrm').addEventListener('change', (e) => e.target.files[0] && onModelPicked(e.target.files[0]));
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

for (const key of ['mirror', 'swapBlink', 'swapHands', 'flipEyeX', 'flipEyeY', 'arms']) {
  const box = $(key);
  box.checked = !!settings[key];
  box.addEventListener('change', () => {
    settings[key] = box.checked;
    persist();
  });
}

for (const key of ['expressions', 'physics']) {
  const box = $(key);
  box.checked = !!settings[key];
  box.addEventListener('change', () => {
    settings[key] = box.checked;
    persist();
    if (key === 'expressions') tracker?.setExpressions(box.checked);
  });
}

const exprGain = $('exprGain');
exprGain.value = settings.exprGain;
exprGain.addEventListener('input', () => { settings.exprGain = +exprGain.value; });
exprGain.addEventListener('change', persist);

$('calib').addEventListener('click', () => {
  if (!tracking) return toast('Start the camera first, then hold a relaxed, neutral face.', 5000);
  toast('Hold a relaxed, neutral face…', 0);
  startExpressionCalibration(() => {
    persist();
    toast('Calibrated. Your resting face is now neutral.');
  });
});

function applyPerf() {
  tracker?.setLevel(level);
  setRatio();
  resize();
}
const perfSel = $('perf');
perfSel.value = settings.perf;
perfSel.addEventListener('change', () => {
  settings.perf = perfSel.value;
  level = settings.perf === 'auto' ? 'balanced' : settings.perf;
  lowFps = 0;
  applyPerf();
  persist();
});

const gain = $('torsoGain');
gain.value = settings.torsoGain;
gain.addEventListener('input', () => { settings.torsoGain = +gain.value; });
gain.addEventListener('change', persist);

// Which emotions are auto-detected.
const emoBoxes = [...document.querySelectorAll('[data-emo]')];
function syncExprSummary() {
  const on = emoBoxes.filter((b) => b.checked).map((b) => b.parentElement.textContent.trim());
  $('expr-sum').textContent = on.length === emoBoxes.length ? 'all' : on.length ? on.join(', ') : 'none';
}
for (const b of emoBoxes) {
  b.checked = settings.exprEnabled[b.dataset.emo] !== false;
  b.addEventListener('change', () => {
    settings.exprEnabled = { ...settings.exprEnabled, [b.dataset.emo]: b.checked };
    syncExprSummary();
    persist();
  });
}
syncExprSummary();

// Face-position calibration (camera not facing you head-on).
function syncPosUI() {
  const on = isPositionCalibrated();
  $('pos-reset').hidden = !on;
  $('pos-calib').textContent = on ? 'Recalibrate face position' : 'Calibrate face position';
}
$('pos-calib').addEventListener('click', () => {
  if (!tracking) return toast('Start the camera first, then look at your screen as you normally would.', 5000);
  toast('Look at your screen like you normally do… hold still.', 0);
  startPositionCalibration(() => {
    persist();
    syncPosUI();
    toast('Calibrated. This posture is now "looking straight ahead".');
  });
});
$('pos-reset').addEventListener('click', () => {
  resetPositionCalibration();
  persist();
  syncPosUI();
  toast('Face position calibration cleared.', 2500);
});
syncPosUI();


// ----------------------------------------------------------- panels + rail ----
hydrateIcons();

const panels = { info: $('panel-info'), settings: $('panel-settings'), textures: $('panel-textures') };
const railBtn = { info: $('btn-info'), settings: $('btn-settings'), textures: $('btn-textures') };

function setPanel(name, open) {
  const narrow = window.innerWidth < 720;
  for (const [k, el] of Object.entries(panels)) {
    if (k === name) continue;
    // Info and Settings share the right side; on small screens only one panel fits at all.
    const sameSide = (k === 'textures') === (name === 'textures');
    if (open && (sameSide || narrow)) el.hidden = true;
  }
  panels[name].hidden = !open;
  for (const [k, el] of Object.entries(panels)) railBtn[k].setAttribute('aria-pressed', String(!el.hidden));
}
for (const name of Object.keys(panels)) {
  railBtn[name].addEventListener('click', () => setPanel(name, panels[name].hidden));
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => setPanel(b.dataset.close, false)));

initTexturePanel({
  list: $('tx-list'),
  filter: $('tx-filter'),
  count: $('tx-count'),
  showAllBtn: $('tx-showall'),
  manager: textures,
  toast,
});

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

const camBtn = $('start');
function setCamUI(on) {
  camBtn.dataset.icon = on ? 'cameraOff' : 'camera';
  camBtn.setAttribute('aria-pressed', String(on));
  camBtn.title = camBtn.ariaLabel = on ? 'Stop camera' : 'Start camera';
  hydrateIcons(camBtn.parentElement);
}
let camBusy = false;

const camSel = $('cam-select');

async function refreshCameras() {
  let devs = [];
  try {
    devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
  } catch {
    /* no permission yet / unsupported */
  }
  camSel.replaceChildren(new Option('Default (front camera)', ''));
  devs.forEach((d, i) => camSel.append(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  camSel.value = devs.some((d) => d.deviceId === settings.cameraId) ? settings.cameraId : '';
}
navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameras);
refreshCameras();

/** Open the chosen camera (falls back to the default one if it has gone away). */
async function openStream() {
  const size = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } };
  const get = (v) => navigator.mediaDevices.getUserMedia({ video: { ...size, ...v }, audio: false });
  let stream;
  if (settings.cameraId) {
    try {
      stream = await get({ deviceId: { exact: settings.cameraId } });
    } catch (err) {
      if (!['OverconstrainedError', 'NotFoundError'].includes(err.name)) throw err;
      settings.cameraId = '';
      persist();
      toast('That camera isn\'t available any more; using the default one.', 4000);
    }
  }
  stream ??= await get({ facingMode: 'user' });
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = stream;
  await video.play();
  await refreshCameras(); // device names only appear once permission is granted
}

camSel.addEventListener('change', async () => {
  settings.cameraId = camSel.value;
  persist();
  if (!tracking) return;
  if (isPositionCalibrated()) {
    resetPositionCalibration();
    persist();
    syncPosUI();
  }
  toast('Switching camera…', 0);
  try {
    await openStream();
    toast('Camera switched.' + ' Re-run "Calibrate face position" if the new camera sits at a different angle.', 5000);
  } catch (err) {
    console.error(err);
    toast(`Couldn't switch camera: ${err.message}`, 6000);
  }
});

async function startCamera() {
  camBusy = true;
  camBtn.disabled = true;
  toast('Starting camera and tracking…', 0);
  try {
    await openStream();
    tracker ??= await Tracker.create();
    tracker.setLevel(level);
    await syncOptionalTrackers();
    tracking = true;
    setCamUI(true);
    toast('Tracking started.');
  } catch (err) {
    console.error(err);
    video.srcObject?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    toast(`Couldn't start tracking: ${err.message}`, 8000);
  } finally {
    camBusy = false;
    camBtn.disabled = false;
  }
}

function stopCamera() {
  tracking = false; // the loop relaxes the avatar back to its idle pose
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  setCamUI(false);
  toast('Camera off.', 2000);
}

camBtn.addEventListener('click', () => {
  if (camBusy) return;
  if (tracking) stopCamera();
  else startCamera();
});

// ------------------------------------------------- hide interface (eye) ----
// Hidden UI returns while the pointer is over the right edge / bottom-right corner (a tap does it on touch).
const hideBtn = $('btn-hideui');
let uiHidden = false;
let peekTimer = 0;
const setPeek = (on) => document.body.classList.toggle('ui-peek', on);

function inPeekZone(x, y) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (x > w - 64 || (x > w - 200 && y > h - 180)) return true;
  for (const el of Object.values(panels)) {
    if (el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}

function setUiHidden(hide) {
  uiHidden = hide;
  document.body.classList.toggle('ui-hidden', hide);
  hideBtn.dataset.icon = hide ? 'eyeOff' : 'eye';
  hideBtn.setAttribute('aria-pressed', String(hide));
  hideBtn.title = hideBtn.ariaLabel = hide ? 'Show interface' : 'Hide interface (move to the right edge or bottom-right to bring it back)';
  hydrateIcons(hideBtn.parentElement);
  if (hide) {
    for (const name of Object.keys(panels)) setPanel(name, false);
    // keep it visible for a moment so the change is obvious, then let hover/tap take over
    setPeek(true);
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => setPeek(false), 1200);
  } else {
    setPeek(false);
  }
}
hideBtn.addEventListener('click', () => setUiHidden(!uiHidden));

window.addEventListener('pointermove', (e) => {
  if (!uiHidden || e.pointerType === 'touch') return;
  clearTimeout(peekTimer);
  setPeek(inPeekZone(e.clientX, e.clientY));
});
window.addEventListener('pointerdown', (e) => {
  if (!uiHidden) return;
  clearTimeout(peekTimer);
  if (inPeekZone(e.clientX, e.clientY)) {
    setPeek(true);
    if (e.pointerType === 'touch') peekTimer = setTimeout(() => setPeek(false), 4000);
  } else if (e.pointerType === 'touch') {
    setPeek(false);
  }
});
document.documentElement.addEventListener('mouseleave', () => uiHidden && setPeek(false));

// ----------------------------------------------------------------- loop ----
const clock = new THREE.Clock();
let frames = 0;
let lowFps = 0;
let fpsAt = performance.now();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();

  textures.tick(now); // advance animated textures (GIF / APNG / WebP)

  if (vrm) {
    if (tracking && tracker) {
      tracker.update(video);

      // Face
      const faceFresh = now - tracker.faceAt < STALE_MS;
      if (faceFresh) applyFaceRig(vrm, tracker.face);
      else relaxFace(vrm);
      updatePositionCalibration(tracker, faceFresh);
      applyExpressions(vrm, tracker, faceFresh);

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
      applyExpressions(vrm, null, false);
    }
    // Spring bones (hair/cloth) can be costly on old GPUs/CPUs; "Fast" turns them off.
    const physics = settings.physics && PERF[level].physics;
    if (!physics && vrm.springBoneManager) {
      const sb = vrm.springBoneManager;
      vrm.springBoneManager = null;
      vrm.update(dt);
      vrm.springBoneManager = sb;
    } else {
      vrm.update(dt); // applies look-at -> expressions, spring bones, etc.
    }
  }
  renderer.render(scene, camera);

  frames++;
  if (now - fpsAt > 1000) {
    const fps = (frames * 1000) / (now - fpsAt);
    const ms = tracker?.ms.face ? ` · face ${Math.round(tracker.ms.face)}ms · ${level}` : '';
    $('fps').textContent = `${Math.round(fps)} fps${ms}`;
    frames = 0;
    fpsAt = now;

    // Auto: if it stays slow with tracking on, drop one quality level (never goes back up by itself).
    if (settings.perf === 'auto' && tracking) {
      lowFps = fps < 18 ? lowFps + 1 : 0;
      const i = LEVELS.indexOf(level);
      if (lowFps >= 2 && i < LEVELS.length - 1) {
        level = LEVELS[i + 1];
        lowFps = 0;
        applyPerf();
        toast(`Auto quality: switched to ${level} to keep it smooth.`, 4000);
      }
    }
  }
});

// ----------------------------------------------------------------- boot ----
rebuildAvatar();

// Test/debug handle: only exists when the page is opened with #debug.
if (location.hash === '#debug') window.__kfl = { textures, settings, get vrm() { return vrm; } };
