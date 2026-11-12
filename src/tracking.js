import * as THREE from 'three';
import * as Kalidokit from 'kalidokit';
import {
  FilesetResolver,
  FaceLandmarker,
  PoseLandmarker,
  HandLandmarker,
} from '@mediapipe/tasks-vision';

const HOSTED = 'https://storage.googleapis.com/mediapipe-models';
const MODELS = {
  face: {
    local: './models/face_landmarker.task',
    hosted: `${HOSTED}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  },
  pose: {
    local: './models/pose_landmarker_lite.task',
    hosted: `${HOSTED}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  },
  hand: {
    local: './models/hand_landmarker.task',
    hosted: `${HOSTED}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
  },
};

export const settings = {
  body: true,        // upper-body tracking (shoulders lean/twist the torso)
  arms: false,       // also track arms (needs elbows/wrists in frame)
  hands: false,      // finger tracking (heavier)
  mirror: false,     // swap left/right (true mirror view)
  swapBlink: false,  // swap which eye blinks
  swapHands: false,  // swap left/right hand labels
  flipEyeX: false,   // eyes look the wrong way horizontally
  flipEyeY: false,   // eyes look the wrong way vertically
  headDamp: 0.7,     // how much head rotation reaches the neck
  smoothing: 0.45,   // higher = snappier, lower = smoother
  perf: 'auto',      // auto | quality | balanced | fast
  physics: true,     // hair/cloth spring bones
  expressions: true, // auto angry/sad/happy/surprised from the face
  exprGain: 1,       // expression strength
  exprBase: null,    // neutral-face baseline from calibration
  torsoGain: 1.4,    // how strongly shoulders lean/twist the upper body
  exprEnabled: { happy: true, angry: true, sad: true, surprised: true }, // which emotions are auto-detected
  cameraId: '',      // chosen camera ('' = default front camera)
  headBase: null,    // face-position calibration: head rotation while looking at the screen
  pupilBase: null,   //   ... eye direction
  spineBase: null,   //   ... shoulder line
};

/** Minimum ms between runs of each model, and render cost. One heavy model runs per camera frame. */
export const PERF = {
  quality:  { face: 33,  pose: 66,  hands: 66,  ratio: 1.5,  physics: true },
  balanced: { face: 66,  pose: 150, hands: 150, ratio: 1.25, physics: true },
  fast:     { face: 100, pose: 300, hands: 300, ratio: 1,    physics: false },
};
export const LEVELS = ['quality', 'balanced', 'fast'];

/**
 * Which model runs on this camera frame? The one most overdue relative to its own interval
 * (ratio >= 1), so a fast model can never starve a slower one. (At "quality" the face was due
 * on every frame and always won, so the body model never ran and the torso never moved.)
 */
export function pickDue(ts, ranAt, intervals, enabled) {
  let best = null;
  let bestRatio = 0;
  for (const k of ['face', 'pose', 'hands']) {
    if (!enabled[k]) continue;
    const ratio = (ts - ranAt[k]) / intervals[k];
    if (ratio >= 1 && ratio > bestRatio) {
      best = k;
      bestRatio = ratio;
    }
  }
  return best;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);

async function createTask(Task, fileset, key, extra = {}) {
  const make = (modelAssetPath, delegate) =>
    Task.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      ...extra,
    });
  // Prefer the self-hosted model, then Google's copy; prefer GPU, then CPU.
  const attempts = [
    [MODELS[key].local, 'GPU'],
    [MODELS[key].hosted, 'GPU'],
    [MODELS[key].local, 'CPU'],
    [MODELS[key].hosted, 'CPU'],
  ];
  let lastError;
  for (const [path, delegate] of attempts) {
    try {
      const task = await make(path, delegate);
      console.info(`[tracking] ${key} ready (${delegate}, ${path})`);
      return task;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error(`Could not start ${key} tracking.`);
}

// ---------------------------------------------------------------------------
// Tracker: face every frame, pose and hands alternate frames to spare old GPUs.
// ---------------------------------------------------------------------------
export class Tracker {
  static async create() {
    const fileset = await FilesetResolver.forVisionTasks('./mediapipe/wasm');
    const face = await createTask(FaceLandmarker, fileset, 'face', {
      numFaces: 1,
      outputFaceBlendshapes: settings.expressions, // used only for emotion detection
      outputFacialTransformationMatrixes: false,
    });
    return new Tracker(fileset, face);
  }

  constructor(fileset, faceLm) {
    this.fileset = fileset;
    this.faceLm = faceLm;
    this.poseLm = null;
    this.handLm = null;
    this.level = 'balanced';
    this.ranAt = { face: -Infinity, pose: -Infinity, hands: -Infinity };
    this.ms = { face: 0, pose: 0, hands: 0 };
    this.blend = null;
    this.blendAt = -Infinity;
    this.lastTime = -1;
    this.face = null;
    this.faceAt = -Infinity;
    this.pose = null; // { rig, vis }
    this.poseAt = -Infinity;
    this.hands = { Left: null, Right: null };
    this.handsAt = -Infinity;
  }

  async enablePose() {
    this.poseLm ??= await createTask(PoseLandmarker, this.fileset, 'pose', { numPoses: 1 });
  }
  disablePose() {
    this.poseLm?.close();
    this.poseLm = null;
    this.pose = null;
  }
  async enableHands() {
    this.handLm ??= await createTask(HandLandmarker, this.fileset, 'hand', { numHands: 2 });
  }
  disableHands() {
    this.handLm?.close();
    this.handLm = null;
    this.hands = { Left: null, Right: null };
  }

  setLevel(level) {
    if (PERF[level]) this.level = level;
  }
  setExpressions(on) {
    this.faceLm.setOptions({ outputFaceBlendshapes: !!on });
    if (!on) this.blend = null;
  }

  /** Call once per render frame. At most ONE model runs per camera frame so work never stacks into a long stall. */
  update(video) {
    if (video.readyState < 2 || video.currentTime === this.lastTime) return;
    this.lastTime = video.currentTime;
    const ts = performance.now();
    const P = PERF[this.level];
    const which = pickDue(ts, this.ranAt, P, { face: true, pose: !!this.poseLm, hands: !!this.handLm });
    const timed = (k, fn) => {
      this.ranAt[k] = ts;
      fn();
      this.ms[k] = this.ms[k] * 0.8 + (performance.now() - ts) * 0.2;
    };

    if (which === 'face') {
      timed('face', () => {
        const res = this.faceLm.detectForVideo(video, ts);
        const fl = res.faceLandmarks?.[0];
        if (fl) {
          const rig = Kalidokit.Face.solve(fl, { runtime: 'mediapipe', video, smoothBlink: true });
          if (rig) {
            rig.eye = Kalidokit.Face.stabilizeBlink(rig.eye, rig.head.y);
            this.face = rig;
            this.faceAt = ts;
          }
        }
        const cats = settings.expressions ? res.faceBlendshapes?.[0]?.categories : null;
        if (cats) {
          const m = {};
          for (const c of cats) m[c.categoryName] = c.score;
          this.blend = m;
          this.blendAt = ts;
        }
      });
      return;
    }

    if (which === 'pose') {
      timed('pose', () => {
        const r = this.poseLm.detectForVideo(video, ts);
        const lm = r.landmarks?.[0];
        const world = r.worldLandmarks?.[0];
        if (!lm || !world) return;
        const rig = Kalidokit.Pose.solve(world, lm, { runtime: 'mediapipe', video, enableLegs: false });
        if (!rig) return;
        const avg = (...i) => i.reduce((s, k) => s + (lm[k].visibility ?? 0), 0) / i.length;
        this.pose = {
          rig,
          vis: {
            // pose landmark indices: 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips
            Left: avg(11, 13, 15) > 0.5,
            Right: avg(12, 14, 16) > 0.5,
            shoulders: avg(11, 12) > 0.5, // enough to lean/twist the upper body
            torso: avg(11, 12, 23, 24) > 0.6, // hips are often off-camera at a desk
          },
        };
        this.poseAt = ts;
      });
      return;
    }

    if (which === 'hands') {
      timed('hands', () => {
        const r = this.handLm.detectForVideo(video, ts);
        const out = { Left: null, Right: null };
        r.landmarks?.forEach((lm, i) => {
          // MediaPipe labels assume a mirrored selfie image; our frames are not mirrored, so invert.
          const label = r.handedness?.[i]?.[0]?.categoryName === 'Left' ? 'Right' : 'Left';
          const side = settings.swapHands ? (label === 'Left' ? 'Right' : 'Left') : label;
          out[side] = Kalidokit.Hand.solve(lm, side);
        });
        this.hands = out;
        this.handsAt = ts;
      });
    }
  }

  close() {
    this.faceLm.close();
    this.poseLm?.close();
    this.handLm?.close();
  }
}

// ---------------------------------------------------------------------------
// Rotations. Kalidokit outputs Euler angles in the VRM 0.x bone frame. three-vrm's
// normalized bones for a VRM 1.0 model sit in a frame turned 180 deg about Y, which
// flips x and z. "Mirror" swaps left/right and reflects y/z (a true mirror view).
// ---------------------------------------------------------------------------
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _ident = new THREE.Quaternion();
const isV1 = (vrm) => vrm.meta?.metaVersion === '1';

/** Slerp a normalized bone toward a Kalidokit rotation (model-frame and mirror aware). */
function setBone(vrm, name, rot, damp, t) {
  const bone = vrm.humanoid?.getNormalizedBoneNode(name);
  if (!bone || !rot) return;
  const f = isV1(vrm) ? -1 : 1;
  const m = settings.mirror ? -1 : 1;
  _euler.set((rot.x ?? 0) * damp * f, (rot.y ?? 0) * damp * m, (rot.z ?? 0) * damp * f * m);
  _quat.setFromEuler(_euler);
  bone.quaternion.slerp(_quat, t);
}

/** Kalidokit name ("LeftUpperArm") -> three-vrm bone name, swapping sides when mirrored. */
function boneFor(name) {
  const n = settings.mirror ? name.replace(/^(Left|Right)/, (x) => (x === 'Left' ? 'Right' : 'Left')) : name;
  return lowerFirst(n);
}

function relaxBone(vrm, name, t) {
  vrm.humanoid?.getNormalizedBoneNode(name)?.quaternion.slerp(_ident, t);
}

/** rot - base (per axis); used to cancel a calibrated camera angle. */
const minus = (r, b) => (b ? { x: (r.x ?? 0) - b.x, y: (r.y ?? 0) - b.y, z: (r.z ?? 0) - b.z } : r);

function setExpr(em, name, target, t) {
  if (!em.getExpression(name)) return;
  em.setValue(name, lerp(em.getValue(name) ?? 0, clamp(target, 0, 1), t));
}

// ---------------------------------------------------------------------------
// Face
// ---------------------------------------------------------------------------
export function applyFaceRig(vrm, rig) {
  if (!vrm || !rig) return;
  const em = vrm.expressionManager;
  const t = settings.smoothing;

  const head = minus(rig.head, settings.headBase);
  setBone(vrm, 'neck', head, settings.headDamp * 0.6, t);
  setBone(vrm, 'head', head, settings.headDamp * 0.4, t);

  if (!em) return;

  // Blink. Kalidokit: 1 = open. Use L/R if the model has them, else the combined preset.
  const hasLR = em.getExpression('blinkLeft') && em.getExpression('blinkRight');
  let l = 1 - rig.eye.l;
  let r = 1 - rig.eye.r;
  if (!settings.mirror !== settings.swapBlink) [l, r] = [r, l];
  if (hasLR) {
    setExpr(em, 'blinkLeft', l, 0.6);
    setExpr(em, 'blinkRight', r, 0.6);
  } else {
    setExpr(em, 'blink', (l + r) / 2, 0.6);
  }

  // Mouth. VRM 0.x A/I/U/E/O are exposed as aa/ih/ou/ee/oh.
  const s = rig.mouth.shape;
  setExpr(em, 'aa', s.A, t);
  setExpr(em, 'ih', s.I, t);
  setExpr(em, 'ou', s.U, t);
  setExpr(em, 'ee', s.E, t);
  setExpr(em, 'oh', s.O, t);

  // Eyes via three-vrm look-at angles -> lookUp/Down/Left/Right expressions
  // (yaw<0 -> lookRight, pitch<0 -> lookUp). No eye bones are rotated.
  const look = vrm.lookAt;
  if (look) {
    const a = look.applier;
    const maxYaw = a?.rangeMapHorizontalOuter?.inputMaxValue ?? 30;
    const maxUp = a?.rangeMapVerticalUp?.inputMaxValue ?? 20;
    const maxDown = a?.rangeMapVerticalDown?.inputMaxValue ?? 20;

    const mx = settings.mirror ? 1 : -1;
    const pb = settings.pupilBase;
    const px = clamp(rig.pupil.x - (pb?.x ?? 0), -1, 1) * mx * (settings.flipEyeX ? -1 : 1);
    const py = clamp(rig.pupil.y - (pb?.y ?? 0), -1, 1) * (settings.flipEyeY ? -1 : 1);

    look.yaw = lerp(look.yaw, -px * maxYaw, t);
    look.pitch = lerp(look.pitch, py > 0 ? -py * maxUp : -py * maxDown, t);
  }
}

export function relaxFace(vrm) {
  if (!vrm) return;
  relaxBone(vrm, 'neck', 0.05);
  relaxBone(vrm, 'head', 0.05);
  if (vrm.lookAt) {
    vrm.lookAt.yaw = lerp(vrm.lookAt.yaw, 0, 0.1);
    vrm.lookAt.pitch = lerp(vrm.lookAt.pitch, 0, 0.1);
  }
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------
// Arms hanging down (radians, Kalidokit/VRM 0.x frame). Without this a VRM sits in a T-pose.
const REST_ARM = { z: 1.2 }; // Left; Right is the mirror image (-1.2)

function restArm(vrm, side, t) {
  const sign = side === 'Left' ? 1 : -1;
  setBone(vrm, boneFor(`${side}UpperArm`), { x: 0, y: 0, z: REST_ARM.z * sign }, 1, t);
  setBone(vrm, boneFor(`${side}LowerArm`), { x: 0, y: 0, z: 0 }, 1, t);
  setBone(vrm, boneFor(`${side}Hand`), { x: 0, y: 0, z: 0 }, 1, t);
}

/** Idle posture: arms down, torso upright. Safe to call every frame. */
export function restBody(vrm, t = 0.12) {
  if (!vrm) return;
  restArm(vrm, 'Left', t);
  restArm(vrm, 'Right', t);
  for (const b of ['hips', 'spine', 'chest', 'upperChest']) relaxBone(vrm, b, t);
}

export function applyPoseRig(vrm, pose) {
  if (!vrm) return;
  if (!pose) return restBody(vrm);
  const { rig, vis } = pose;
  const t = 0.3;

  for (const side of ['Left', 'Right']) {
    if (settings.arms && vis[side]) {
      setBone(vrm, boneFor(`${side}UpperArm`), rig[`${side}UpperArm`], 1, t);
      setBone(vrm, boneFor(`${side}LowerArm`), rig[`${side}LowerArm`], 1, t);
      setBone(vrm, boneFor(`${side}Hand`), { x: 0, y: 0, z: rig[`${side}Hand`]?.z ?? 0 }, 1, t);
    } else {
      restArm(vrm, side, 0.1);
    }
  }

  // Lean/twist comes from the shoulder line alone, so it works with only head and
  // shoulders in frame. Hips need to be visible too, otherwise they stay put.
  if (vis.shoulders) {
    const g = settings.torsoGain;
    const spine = minus(rig.Spine, settings.spineBase);
    setBone(vrm, 'spine', spine, 0.4 * g, t);
    setBone(vrm, 'chest', spine, 0.3 * g, t);
    setBone(vrm, 'upperChest', spine, 0.2 * g, t);
  } else {
    for (const b of ['spine', 'chest', 'upperChest']) relaxBone(vrm, b, 0.08);
  }
  if (vis.torso) setBone(vrm, 'hips', rig.Hips?.rotation, 0.5, t);
  else relaxBone(vrm, 'hips', 0.08);
}

// ---------------------------------------------------------------------------
// Hands / fingers
// ---------------------------------------------------------------------------
const FINGERS = ['Ring', 'Index', 'Middle', 'Little'];
const SEGMENTS = ['Proximal', 'Intermediate', 'Distal'];
// Kalidokit uses the VRM 0.x thumb names; VRM 1.0 (and three-vrm) renamed them.
const THUMB = { Proximal: 'Metacarpal', Intermediate: 'Proximal', Distal: 'Distal' };

export function applyHandRigs(vrm, hands, pose) {
  if (!vrm || !hands) return;
  for (const side of ['Left', 'Right']) {
    const h = hands[side];
    if (!h) continue;
    const wrist = h[`${side}Wrist`];
    // Wrist twist from the hand model, tilt from the pose model when available.
    setBone(vrm, boneFor(`${side}Hand`), {
      x: wrist?.x ?? 0,
      y: wrist?.y ?? 0,
      z: pose?.rig?.[`${side}Hand`]?.z ?? wrist?.z ?? 0,
    }, 1, 0.4);

    for (const f of FINGERS) {
      for (const s of SEGMENTS) {
        setBone(vrm, boneFor(`${side}${f}${s}`), h[`${side}${f}${s}`], 1, 0.4);
      }
    }
    for (const s of SEGMENTS) {
      setBone(vrm, boneFor(`${side}Thumb${THUMB[s]}`), h[`${side}Thumb${s}`], 1, 0.4);
    }
  }
}

export function relaxHands(vrm, t = 0.15) {
  if (!vrm) return;
  for (const side of ['Left', 'Right']) {
    for (const f of FINGERS) for (const s of SEGMENTS) relaxBone(vrm, boneFor(`${side}${f}${s}`), t);
    for (const s of SEGMENTS) relaxBone(vrm, boneFor(`${side}Thumb${THUMB[s]}`), t);
  }
}

// ---------------------------------------------------------------------------
// Emotions from MediaPipe's face blendshapes: angry / sad (sorrow) / happy (joy) / surprised.
// VRM 0.x Joy, Sorrow, Angry map to happy, sad, angry in three-vrm; surprised needs a VRM 1.0 model.
// ---------------------------------------------------------------------------
const EMOTIONS = ['happy', 'angry', 'sad', 'surprised'];
const SCALE = { happy: 1.6, angry: 1.5, sad: 1.7, surprised: 1.3 }; // raw scores have different ranges
const THRESHOLD = 0.25; // ignore faint signals so a resting face stays neutral
const emo = { happy: 0, angry: 0, sad: 0, surprised: 0 };
const emoTarget = { happy: 0, angry: 0, sad: 0, surprised: 0 };
let lastBlendAt = -1;
let calib = null;

const pair = (m, a, b) => ((m[a] ?? 0) + (m[b] ?? 0)) / 2;

function rawEmotions(m) {
  const smile = pair(m, 'mouthSmileLeft', 'mouthSmileRight');
  const frown = pair(m, 'mouthFrownLeft', 'mouthFrownRight');
  const browDown = pair(m, 'browDownLeft', 'browDownRight');
  const browOuter = pair(m, 'browOuterUpLeft', 'browOuterUpRight');
  const inner = m.browInnerUp ?? 0;
  return {
    happy: smile + 0.3 * pair(m, 'cheekSquintLeft', 'cheekSquintRight'),
    angry:
      browDown + 0.5 * pair(m, 'noseSneerLeft', 'noseSneerRight') +
      0.3 * pair(m, 'eyeSquintLeft', 'eyeSquintRight') + 0.3 * pair(m, 'mouthPressLeft', 'mouthPressRight') -
      0.5 * smile,
    sad: 0.6 * inner + 1.2 * frown - 0.4 * smile,
    surprised: 0.6 * browOuter + 0.4 * inner + 0.5 * pair(m, 'eyeWideLeft', 'eyeWideRight'),
  };
}

/** Record ~1.5 s of your resting face as the "zero" point. */
export function startExpressionCalibration(onDone) {
  calib = { n: 0, sum: { happy: 0, angry: 0, sad: 0, surprised: 0 }, onDone };
}

export function applyExpressions(vrm, tracker, fresh) {
  const em = vrm?.expressionManager;
  if (!em) return;

  if (!settings.expressions || !fresh || !tracker?.blend) {
    for (const k of EMOTIONS) emoTarget[k] = 0;
  } else if (tracker.blendAt !== lastBlendAt) {
    lastBlendAt = tracker.blendAt;
    const raw = rawEmotions(tracker.blend);

    if (calib) {
      for (const k of EMOTIONS) calib.sum[k] += raw[k];
      if (++calib.n >= 20) {
        settings.exprBase = Object.fromEntries(EMOTIONS.map((k) => [k, calib.sum[k] / calib.n]));
        const done = calib.onDone;
        calib = null;
        done?.();
      }
    }

    // Only the strongest emotion shows, so happy and angry never blend into a mush.
    const base = settings.exprBase ?? {};
    let best = null;
    let bestV = 0;
    for (const k of EMOTIONS) {
      if (settings.exprEnabled?.[k] === false) {
        emoTarget[k] = 0; // switched off in the dropdown: never auto-detected
        continue;
      }
      const v = clamp((raw[k] - (base[k] ?? 0)) * SCALE[k] * settings.exprGain, 0, 1);
      const x = v < THRESHOLD ? 0 : (v - THRESHOLD) / (1 - THRESHOLD);
      emoTarget[k] = 0;
      if (x > bestV) {
        bestV = x;
        best = k;
      }
    }
    if (best) emoTarget[best] = bestV;
  }

  for (const k of EMOTIONS) {
    emo[k] = lerp(emo[k], emoTarget[k], emoTarget[k] > emo[k] ? 0.25 : 0.12); // quick on, slower off
    if (em.getExpression(k)) em.setValue(k, emo[k]);
  }
}

// ---------------------------------------------------------------------------
// Face-position calibration for cameras that aren't straight ahead (a webcam above or beside
// the screen). While you look at your screen like you normally do, the average head rotation,
// eye direction and shoulder line are recorded, then subtracted so that pose reads as "neutral".
// ---------------------------------------------------------------------------
let posCalib = null;
const CALIB_SAMPLES = 20;

export function isPositionCalibrated() {
  return !!settings.headBase;
}

/** Waits `delayMs` so you can settle after pressing the button, then records ~1 s of samples. */
export function startPositionCalibration(onDone, delayMs = 1500) {
  posCalib = {
    startAt: performance.now() + delayMs,
    n: 0,
    lastFace: -1,
    head: { x: 0, y: 0, z: 0 },
    pupil: { x: 0, y: 0 },
    spineN: 0,
    lastPose: -1,
    spine: { x: 0, y: 0, z: 0 },
    onDone,
  };
}

export function resetPositionCalibration() {
  posCalib = null;
  settings.headBase = settings.pupilBase = settings.spineBase = null;
}

/** Call every frame while tracking with fresh data; `faceFresh` = the face result is current. */
export function updatePositionCalibration(tracker, faceFresh) {
  const c = posCalib;
  if (!c || !faceFresh || !tracker.face || performance.now() < c.startAt) return;

  if (tracker.faceAt !== c.lastFace) {
    c.lastFace = tracker.faceAt;
    const h = tracker.face.head;
    c.head.x += h.x; c.head.y += h.y; c.head.z += h.z;
    c.pupil.x += tracker.face.pupil.x; c.pupil.y += tracker.face.pupil.y;
    c.n++;
  }
  if (tracker.pose?.vis.shoulders && tracker.poseAt !== c.lastPose) {
    c.lastPose = tracker.poseAt;
    const sp = tracker.pose.rig.Spine;
    c.spine.x += sp.x; c.spine.y += sp.y; c.spine.z += sp.z;
    c.spineN++;
  }

  if (c.n >= CALIB_SAMPLES) {
    const n = c.n;
    settings.headBase = { x: c.head.x / n, y: c.head.y / n, z: c.head.z / n };
    settings.pupilBase = { x: c.pupil.x / n, y: c.pupil.y / n };
    settings.spineBase = c.spineN ? { x: c.spine.x / c.spineN, y: c.spine.y / c.spineN, z: c.spine.z / c.spineN } : null;
    posCalib = null;
    c.onDone?.();
  }
}
