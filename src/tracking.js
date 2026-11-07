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
  body: true,        // upper-body tracking (arms, torso)
  hands: false,      // finger tracking (heavier)
  mirror: false,     // swap left/right (true mirror view)
  swapBlink: false,  // swap which eye blinks
  swapHands: false,  // swap left/right hand labels
  flipEyeX: false,   // eyes look the wrong way horizontally
  flipEyeY: false,   // eyes look the wrong way vertically
  headDamp: 0.7,     // how much head rotation reaches the neck
  smoothing: 0.45,   // higher = snappier, lower = smoother
};

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
      outputFaceBlendshapes: false, // Kalidokit solves from landmarks; skip the extra cost
      outputFacialTransformationMatrixes: false,
    });
    return new Tracker(fileset, face);
  }

  constructor(fileset, faceLm) {
    this.fileset = fileset;
    this.faceLm = faceLm;
    this.poseLm = null;
    this.handLm = null;
    this.n = 0;
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

  /** Call once per render frame; does work only when the camera delivered a new frame. */
  update(video) {
    if (video.readyState < 2 || video.currentTime === this.lastTime) return;
    this.lastTime = video.currentTime;
    this.n++;
    const ts = performance.now();

    // Face: every frame.
    const fl = this.faceLm.detectForVideo(video, ts).faceLandmarks?.[0];
    if (fl) {
      const rig = Kalidokit.Face.solve(fl, { runtime: 'mediapipe', video, smoothBlink: true });
      if (rig) {
        rig.eye = Kalidokit.Face.stabilizeBlink(rig.eye, rig.head.y);
        this.face = rig;
        this.faceAt = ts;
      }
    }

    // Pose: every other frame.
    if (this.poseLm && this.n % 2 === 0) {
      const r = this.poseLm.detectForVideo(video, ts);
      const lm = r.landmarks?.[0];
      const world = r.worldLandmarks?.[0];
      if (lm && world) {
        const rig = Kalidokit.Pose.solve(world, lm, { runtime: 'mediapipe', video, enableLegs: false });
        if (rig) {
          const avg = (...i) => i.reduce((s, k) => s + (lm[k].visibility ?? 0), 0) / i.length;
          this.pose = {
            rig,
            vis: {
              // pose landmark indices: 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips
              Left: avg(11, 13, 15) > 0.5,
              Right: avg(12, 14, 16) > 0.5,
              torso: avg(11, 12, 23, 24) > 0.6, // hips are often off-camera at a desk
            },
          };
          this.poseAt = ts;
        }
      }
    }

    // Hands: the other frames.
    if (this.handLm && this.n % 2 === 1) {
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

  setBone(vrm, 'neck', rig.head, settings.headDamp * 0.6, t);
  setBone(vrm, 'head', rig.head, settings.headDamp * 0.4, t);

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
    const px = clamp(rig.pupil.x, -1, 1) * mx * (settings.flipEyeX ? -1 : 1);
    const py = clamp(rig.pupil.y, -1, 1) * (settings.flipEyeY ? -1 : 1);

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
  for (const b of ['hips', 'spine', 'chest']) relaxBone(vrm, b, t);
}

export function applyPoseRig(vrm, pose) {
  if (!vrm) return;
  if (!pose) return restBody(vrm);
  const { rig, vis } = pose;
  const t = 0.3;

  for (const side of ['Left', 'Right']) {
    if (vis[side]) {
      setBone(vrm, boneFor(`${side}UpperArm`), rig[`${side}UpperArm`], 1, t);
      setBone(vrm, boneFor(`${side}LowerArm`), rig[`${side}LowerArm`], 1, t);
      setBone(vrm, boneFor(`${side}Hand`), { x: 0, y: 0, z: rig[`${side}Hand`]?.z ?? 0 }, 1, t);
    } else {
      restArm(vrm, side, 0.1);
    }
  }

  if (vis.torso) {
    setBone(vrm, 'hips', rig.Hips?.rotation, 0.5, t);
    setBone(vrm, 'chest', rig.Spine, 0.25, t);
    setBone(vrm, 'spine', rig.Spine, 0.45, t);
  } else {
    for (const b of ['hips', 'spine', 'chest']) relaxBone(vrm, b, 0.08);
  }
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
