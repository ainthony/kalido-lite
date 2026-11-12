import { loadMedia } from './media.js';
import { loadFile, saveFile, removeFile } from './storage.js';
import { whiteTexture } from './flatMaterial.js';

/**
 * Everything the texture panel can do to a model.
 *
 * A "group" is one texture as the user sees it: every material sharing the same colour map
 * (or, for colour-only materials, that single material), plus the meshes drawn with it.
 *
 *   hide      hides those meshes - the 3D parts that use the texture
 *   replace   swaps the colour map for another image / animation / video
 *   effect    an extra layer over the texture: "screen" (spray) or "uv" (sticks to the model),
 *             with an optional mask
 *
 * Choices are remembered per model (file name + size): flags in localStorage, picked files in IndexedDB.
 */

const SLOTS = ['replace', 'layer', 'mask'];

export class TextureManager {
  constructor() {
    this.groups = [];
    this.sig = '';
    this.vrm = null;
    this.listeners = new Set();
    this.token = 0; // guards async restores against a newer model
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    this.listeners.forEach((fn) => fn(this.groups));
  }

  // ----------------------------------------------------------------- setup ----
  /** Call after applyFlatShading(vrm). Resolves once saved choices have been re-applied. */
  async attach(vrm, sig) {
    this.release();
    this.vrm = vrm;
    this.sig = sig;
    const token = ++this.token;

    const byKey = new Map();
    vrm.scene.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat.userData.fx) continue; // hidden MToon outline passes
        const id = mat.map ? `map:${mat.map.uuid}` : `mat:${mat.uuid}`;
        let g = byKey.get(id);
        if (!g) {
          g = {
            materials: new Set(),
            meshes: new Set(),
            map: mat.map ?? null,
            hidden: false,
            replace: null,
            effect: { on: false, mode: 'screen', layer: null, mask: null },
            open: false,
          };
          byKey.set(id, g);
        }
        g.materials.add(mat);
        g.meshes.add(mesh);
      }
    });

    // Names: the texture's own name when it has one, otherwise the material's.
    const used = new Map();
    this.groups = [...byKey.values()].map((g) => {
      g.materials = [...g.materials];
      g.meshes = [...g.meshes];
      g.original = new Map(g.materials.map((m) => [m, { alphaTest: m.alphaTest, transparent: m.transparent }]));
      const matNames = g.materials.map((m) => m.name).filter(Boolean);
      g.matNames = [...new Set(matNames)];
      let label = g.map?.name || g.matNames[0] || 'Unnamed texture';
      const n = (used.get(label) ?? 0) + 1;
      used.set(label, n);
      if (n > 1) label = `${label} (${n})`;
      g.label = label;
      g.key = `${g.matNames.slice().sort().join('+')}|${g.map?.name ?? ''}|${n}`;
      return g;
    });
    this.emit();

    await this.restore(token);
  }

  release() {
    for (const g of this.groups) {
      g.replace?.dispose();
      g.effect.layer?.dispose();
      g.effect.mask?.dispose();
    }
    this.groups = [];
    this.vrm = null;
  }

  // ------------------------------------------------------------ persistence ----
  fileKey(g, slot) {
    return `tx:${this.sig}:${g.key}:${slot}`;
  }
  stateKey() {
    return `kfl-tex:${this.sig}`;
  }
  save() {
    try {
      const state = {};
      for (const g of this.groups) {
        if (g.hidden || g.effect.on || g.effect.mode !== 'screen') {
          state[g.key] = { hidden: g.hidden, on: g.effect.on, mode: g.effect.mode };
        }
      }
      localStorage.setItem(this.stateKey(), JSON.stringify(state));
    } catch {
      /* private mode: ignore */
    }
  }

  async restore(token) {
    let state = {};
    try {
      state = JSON.parse(localStorage.getItem(this.stateKey()) || '{}');
    } catch {
      /* ignore */
    }
    for (const g of this.groups) {
      const s = state[g.key];
      if (s) {
        g.hidden = !!s.hidden;
        g.effect.on = !!s.on;
        g.effect.mode = s.mode === 'uv' ? 'uv' : 'screen';
      }
      for (const slot of SLOTS) {
        let file;
        try {
          file = await loadFile(this.fileKey(g, slot));
        } catch {
          file = null;
        }
        if (token !== this.token) return; // a newer model took over
        if (!file) continue;
        try {
          this.assign(g, slot, await loadMedia(file), false);
        } catch (err) {
          console.warn(`[textures] couldn't restore ${slot} for ${g.label}:`, err);
        }
      }
      this.apply(g);
    }
    if (token === this.token) this.emit();
  }

  // ------------------------------------------------------------- applying ----
  /** Push a group's state onto its materials and meshes. */
  apply(g) {
    const e = g.effect;
    const active = e.on && !!e.layer;
    const wantMap = g.replace?.texture ?? g.map ?? (active ? whiteTexture() : null);

    for (const m of g.materials) {
      if (m.map !== wantMap) {
        m.map = wantMap;
        m.needsUpdate = true; // map presence changes the compiled program
      }
      // A replacement image/animation with transparent pixels should cut through the model
      // (like a cutout) instead of drawing them black. Materials already blending keep doing so.
      const o = g.original.get(m);
      const cut = g.replace && !o.transparent ? Math.max(o.alphaTest, 0.5) : o.alphaTest;
      if (m.alphaTest !== cut) {
        m.alphaTest = cut;
        m.needsUpdate = true;
      }

      const fx = m.userData.fx;
      fx.uEffect.value = active ? 1 : 0;
      fx.uMode.value = e.mode === 'screen' ? 1 : 0;
      fx.uLayer.value = e.layer?.texture ?? whiteTexture();
      fx.uMask.value = e.mask?.texture ?? whiteTexture();
      fx.uHasMask.value = e.mask ? 1 : 0;
    }

    // Hide: the mesh itself when this material is all it draws, otherwise just that material.
    for (const mesh of g.meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.length === 1) mesh.visible = !g.hidden;
      else for (const m of mats) if (g.materials.includes(m)) m.visible = !g.hidden;
    }
  }

  assign(g, slot, media, persistChoice = true) {
    if (slot === 'replace') {
      g.replace?.dispose();
      g.replace = media;
    } else {
      const prev = g.effect[slot];
      prev?.dispose();
      g.effect[slot] = media;
      if (slot === 'layer' && media && persistChoice) g.effect.on = true;
    }
  }

  // ---------------------------------------------------- user-facing actions ----
  setHidden(g, hidden) {
    g.hidden = hidden;
    this.apply(g);
    this.save();
    this.emit();
  }

  setMode(g, mode) {
    g.effect.mode = mode;
    this.apply(g);
    this.save();
    this.emit();
  }

  setEffectOn(g, on) {
    g.effect.on = on;
    this.apply(g);
    this.save();
    this.emit();
  }

  /** slot: 'replace' | 'layer' | 'mask'. Resolves to the media (check .note for warnings). */
  async setFile(g, slot, file) {
    const media = await loadMedia(file);
    this.assign(g, slot, media);
    this.apply(g);
    this.save();
    saveFile(this.fileKey(g, slot), file).catch(() => {});
    this.emit();
    return media;
  }

  clearFile(g, slot) {
    this.assign(g, slot, null);
    this.apply(g);
    this.save();
    removeFile(this.fileKey(g, slot)).catch(() => {});
    this.emit();
  }

  resetGroup(g) {
    for (const slot of SLOTS) {
      if (slot === 'replace' ? g.replace : g.effect[slot]) this.clearFile(g, slot);
    }
    g.hidden = false;
    g.effect.on = false;
    g.effect.mode = 'screen';
    this.apply(g);
    this.save();
    this.emit();
  }

  showAll() {
    for (const g of this.groups) {
      g.hidden = false;
      this.apply(g);
    }
    this.save();
    this.emit();
  }

  /** Call every render frame: advances animated textures. */
  tick(now) {
    for (const g of this.groups) {
      g.replace?.update(now);
      if (g.effect.on) {
        g.effect.layer?.update(now);
        g.effect.mask?.update(now);
      }
    }
  }
}
