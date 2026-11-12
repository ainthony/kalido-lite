import * as THREE from 'three';
import { parseGIF, decompressFrames } from 'gifuct-js';
import UPNG from 'upng-js';

/**
 * Turn a user file into something a material can use as a texture.
 *
 *   still image (png/jpg/webp/...)  -> THREE.Texture
 *   GIF, APNG                        -> decoded in JS, composited onto a canvas texture
 *   animated WebP                    -> WebCodecs ImageDecoder when the browser has it, otherwise a
 *                                       best-effort live <img> (Safari 16 can't decode WebP frames to JS)
 *   MP4 / WebM                       -> VideoTexture (muted, looping) - cheapest option on old iPads
 *
 * Every loader returns { texture, kind, animated, name, note?, update(nowMs), dispose() }.
 * `update` is called once per render frame and only uploads when the frame changed.
 */

const MAX_DIM = 512;                      // animations bigger than this are scaled down (old iPad memory)
const MAX_FRAME_BYTES = 96 * 1024 * 1024; // decoded-frame budget; extra frames are dropped
const MIN_DELAY = 20;                     // ms; browsers treat 0-10 ms GIF delays as 100 ms

export const MEDIA_ACCEPT = 'image/*,video/mp4,video/webm,.gif,.apng,.webp,.mp4,.webm';

const latin1 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
};

/** What is this file really? Extensions lie; headers don't. */
export async function sniffMedia(file) {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const s = latin1(head);
  if (s.startsWith('GIF8')) return 'gif';
  if (head[0] === 0x89 && s.slice(1, 4) === 'PNG') return s.includes('acTL') ? 'apng' : 'image';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') {
    return s.slice(12, 16) === 'VP8X' && (head[20] & 0x02) ? 'webp-anim' : 'image';
  }
  if (file.type.startsWith('video/') || s.slice(4, 8) === 'ftyp' || (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)) {
    return 'video';
  }
  return 'image';
}

function configure(tex, animated) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false; // glTF/mesh UV convention (v down); screen-space use flips in the shader
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (animated) {
    tex.minFilter = THREE.LinearFilter; // no mipmap rebuild on every frame
    tex.generateMipmaps = false;
  } else {
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 2; // cheap on an A9X
  }
  return tex;
}

const makeCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

function fit(w, h) {
  const s = Math.min(1, MAX_DIM / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// ------------------------------------------------------------------ still ----
async function loadStatic(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`Couldn't read "${file.name}" as an image.`);
  }
  const tex = configure(new THREE.Texture(img), false);
  tex.needsUpdate = true;
  return {
    texture: tex,
    kind: 'image',
    animated: false,
    update() {},
    dispose() {
      tex.dispose();
      URL.revokeObjectURL(url);
    },
  };
}

// --------------------------------------------------------- frame sequences ----
/**
 * Shared player for anything decoded to discrete frames.
 * `drawFrame(i, prev)` returns a canvas/bitmap holding the *finished* image for frame i.
 */
function makePlayer({ w, h, delays, drawFrame, kind, onDispose }) {
  const size = fit(w, h);
  const out = makeCanvas(size.w, size.h);
  const ctx = out.getContext('2d');
  const tex = configure(new THREE.CanvasTexture(out), true);

  const starts = [];
  let total = 0;
  for (const d of delays) {
    starts.push(total);
    total += Math.max(MIN_DELAY, d);
  }

  let cur = -1;
  let t0 = null;

  const show = (i) => {
    const src = drawFrame(i, cur);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.drawImage(src, 0, 0, size.w, size.h);
    tex.needsUpdate = true;
    cur = i;
  };
  const indexAt = (ms) => {
    const t = ms % total;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  show(0);
  const animated = delays.length > 1;
  return {
    texture: tex,
    kind,
    animated,
    update(now) {
      if (!animated) return;
      t0 ??= now;
      const i = indexAt(now - t0);
      if (i !== cur) show(i);
    },
    dispose() {
      tex.dispose();
      onDispose?.();
    },
  };
}

async function loadGif(file) {
  const gif = parseGIF(await file.arrayBuffer());
  let frames = decompressFrames(gif, true);
  if (!frames.length) throw new Error('Empty GIF.');
  const W = gif.lsd.width;
  const H = gif.lsd.height;

  const maxFrames = Math.max(2, Math.floor(MAX_FRAME_BYTES / (W * H * 4)));
  let truncated = false;
  if (frames.length > maxFrames) {
    frames = frames.slice(0, maxFrames);
    truncated = true;
  }

  const comp = makeCanvas(W, H);
  const cctx = comp.getContext('2d', { willReadFrequently: true });
  const scratch = makeCanvas(1, 1);
  const sctx = scratch.getContext('2d');
  let snapshot = null;

  const apply = (k) => {
    const f = frames[k];
    if (k > 0) {
      // Undo the previous frame as its disposal method asks.
      const p = frames[k - 1];
      if (p.disposalType === 2) cctx.clearRect(p.dims.left, p.dims.top, p.dims.width, p.dims.height);
      else if (p.disposalType === 3 && snapshot) cctx.putImageData(snapshot, 0, 0);
    }
    if (f.disposalType === 3) snapshot = cctx.getImageData(0, 0, W, H);
    scratch.width = f.dims.width;
    scratch.height = f.dims.height;
    sctx.putImageData(new ImageData(f.patch, f.dims.width, f.dims.height), 0, 0);
    cctx.drawImage(scratch, f.dims.left, f.dims.top);
  };

  const m = makePlayer({
    w: W,
    h: H,
    kind: 'gif',
    delays: frames.map((f) => f.delay || 100),
    drawFrame(i, prev) {
      // Frames build on each other, so replay any we skipped.
      let k = prev;
      if (i === 0 || i < prev) {
        cctx.clearRect(0, 0, W, H);
        snapshot = null;
        k = -1;
      }
      while (k < i) apply(++k);
      return comp;
    },
  });
  if (truncated) m.note = `Long GIF: only the first ${frames.length} frames are used to save memory.`;
  return m;
}

async function loadApng(file) {
  const png = UPNG.decode(await file.arrayBuffer());
  if (!png.frames || png.frames.length < 2) return loadStatic(file);
  const W = png.width;
  const H = png.height;
  let rgba = UPNG.toRGBA8(png);
  let delays = png.frames.map((f) => f.delay || 100);

  const maxFrames = Math.max(2, Math.floor(MAX_FRAME_BYTES / (W * H * 4)));
  let truncated = false;
  if (rgba.length > maxFrames) {
    rgba = rgba.slice(0, maxFrames);
    delays = delays.slice(0, maxFrames);
    truncated = true;
  }

  const fc = makeCanvas(W, H);
  const fctx = fc.getContext('2d');
  const m = makePlayer({
    w: W,
    h: H,
    kind: 'apng',
    delays,
    drawFrame(i) {
      fctx.putImageData(new ImageData(new Uint8ClampedArray(rgba[i]), W, H), 0, 0);
      return fc;
    },
  });
  if (truncated) m.note = `Long APNG: only the first ${rgba.length} frames are used to save memory.`;
  return m;
}

/** Animated WebP: real frame decoding where WebCodecs exists, otherwise a live <img> drawn to a canvas. */
async function loadAnimatedWebp(file) {
  if ('ImageDecoder' in window) {
    const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/webp' });
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack.frameCount;
    const bitmaps = [];
    const delays = [];
    let bytes = 0;
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      bytes += image.displayWidth * image.displayHeight * 4;
      if (bytes > MAX_FRAME_BYTES && bitmaps.length >= 2) {
        image.close();
        break;
      }
      bitmaps.push(await createImageBitmap(image));
      delays.push((image.duration ?? 100000) / 1000);
      image.close();
    }
    return makePlayer({
      w: bitmaps[0].width,
      h: bitmaps[0].height,
      kind: 'webp',
      delays,
      drawFrame: (i) => bitmaps[i],
      onDispose() {
        bitmaps.forEach((b) => b.close());
        decoder.close();
      },
    });
  }

  // Fallback (Safari 16): let the browser animate an <img> and copy its current frame.
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  Object.assign(img.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none' });
  document.body.appendChild(img);

  const size = fit(img.naturalWidth, img.naturalHeight);
  const out = makeCanvas(size.w, size.h);
  const ctx = out.getContext('2d');
  const tex = configure(new THREE.CanvasTexture(out), true);
  let last = -Infinity;
  const draw = () => {
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.drawImage(img, 0, 0, size.w, size.h);
    tex.needsUpdate = true;
  };
  draw();
  return {
    texture: tex,
    kind: 'webp',
    animated: true,
    note: 'Animated WebP is best-effort in this browser. If it looks frozen, use GIF, APNG or MP4.',
    update(now) {
      if (now - last < 33) return;
      last = now;
      draw();
    },
    dispose() {
      tex.dispose();
      img.remove();
      URL.revokeObjectURL(url);
    },
  };
}

// ------------------------------------------------------------------ video ----
async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.src = url;
  await new Promise((resolve, reject) => {
    v.onloadeddata = resolve;
    v.onerror = () => reject(new Error(`Couldn't play "${file.name}". Try an H.264 MP4.`));
  });
  try {
    await v.play();
  } catch {
    /* autoplay refused; the first frame still shows */
  }
  const tex = configure(new THREE.VideoTexture(v), true); // the renderer refreshes it each frame
  return {
    texture: tex,
    kind: 'video',
    animated: true,
    update() {},
    dispose() {
      v.pause();
      v.removeAttribute('src');
      v.load();
      tex.dispose();
      URL.revokeObjectURL(url);
    },
  };
}

// -------------------------------------------------------------- entrypoint ----
export async function loadMedia(file) {
  const kind = await sniffMedia(file);
  let media;
  try {
    if (kind === 'gif') media = await loadGif(file);
    else if (kind === 'apng') media = await loadApng(file);
    else if (kind === 'webp-anim') media = await loadAnimatedWebp(file);
    else if (kind === 'video') media = await loadVideo(file);
    else media = await loadStatic(file);
  } catch (err) {
    if (kind === 'image' || kind === 'video') throw err;
    console.warn(`[media] ${kind} decode failed, falling back to a still frame:`, err);
    media = await loadStatic(file);
    media.note = `Couldn't animate "${file.name}"; showing a still frame.`;
  }
  media.name = file.name;
  return media;
}
