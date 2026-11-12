import { MEDIA_ACCEPT } from './media.js';
import { icon } from './icons.js';

/** Tiny DOM helper: h('div', {class:'x', onclick}, child, child...) */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

/**
 * The left-hand texture panel: one row per texture on the model, each with
 * Hide, Replace and Effect (spray / follow-UV layer + mask) controls.
 */
export function initTexturePanel({ list, filter, count, showAllBtn, manager, toast }) {
  const empty = h('p', { class: 'tx-empty' }, 'Load a model to see its textures.');

  function pick(g, slot) {
    const input = h('input', { type: 'file', accept: MEDIA_ACCEPT });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      toast(`Loading ${file.name}…`, 0);
      try {
        const media = await manager.setFile(g, slot, file);
        toast(media.note ?? (media.animated ? 'Animated texture ready.' : 'Texture applied.'), media.note ? 7000 : 2500);
      } catch (err) {
        console.error(err);
        toast(err.message || 'Could not load that file.', 7000);
      }
    });
    input.click(); // must run inside the tap handler so iOS allows the picker
  }

  function fileRow(g, label, media, slot) {
    return h(
      'div',
      { class: 'fr' },
      h('span', { class: 'fl' }, label),
      h('button', { type: 'button', onclick: () => pick(g, slot) }, media ? 'Change' : 'Choose…'),
      media
        ? [
            h('span', { class: 'fn', title: media.name }, media.animated ? icon('film') : null, media.name),
            h('button', { type: 'button', class: 'x', title: 'Remove', 'aria-label': `Remove ${label}`, onclick: () => manager.clearFile(g, slot) }, icon('x')),
          ]
        : null
    );
  }

  function details(g) {
    const e = g.effect;
    return h(
      'div',
      { class: 'tx-body' },
      h('div', { class: 'grp' }, h('h4', {}, 'Replace texture'), fileRow(g, 'Image / animation', g.replace, 'replace')),
      h(
        'div',
        { class: 'grp' },
        h('h4', {}, 'Texture effects'),
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-label': 'Effect mode' },
          h('button', { type: 'button', 'aria-pressed': String(e.mode === 'screen'), onclick: () => manager.setMode(g, 'screen') }, 'Spray (screen)'),
          h('button', { type: 'button', 'aria-pressed': String(e.mode === 'uv'), onclick: () => manager.setMode(g, 'uv') }, 'Follow UV')
        ),
        fileRow(g, 'Add texture', e.layer, 'layer'),
        fileRow(g, 'Mask', e.mask, 'mask'),
        h(
          'label',
          { class: 'sw' },
          h('input', { type: 'checkbox', checked: e.on && !!e.layer, disabled: !e.layer, onchange: (ev) => manager.setEffectOn(g, ev.target.checked) }),
          e.layer ? 'Effect on' : 'Effect on (add a texture first)'
        )
      ),
      h('button', { type: 'button', class: 'reset', onclick: () => manager.resetGroup(g) }, 'Reset this texture')
    );
  }

  function row(g) {
    const tags = [g.hidden && 'hidden', g.replace && 'replaced', g.effect.on && g.effect.layer && (g.effect.mode === 'uv' ? 'UV effect' : 'spray')].filter(Boolean);
    const sub = `${g.matNames.join(', ') || 'no material name'} · ${g.meshes.length} mesh${g.meshes.length === 1 ? '' : 'es'}`;
    return h(
      'div',
      { class: `tx${g.hidden ? ' is-hidden' : ''}${g.open ? ' open' : ''}` },
      h(
        'div',
        { class: 'tx-head' },
        h(
          'button',
          {
            type: 'button',
            class: 'tx-title',
            'aria-expanded': String(!!g.open),
            onclick: () => {
              g.open = !g.open;
              render();
            },
          },
          h('span', { class: 'tx-name', title: g.label }, g.label),
          h('span', { class: 'tx-sub', title: sub }, sub),
          tags.length ? h('span', { class: 'tx-tags' }, tags.map((t) => h('em', {}, t))) : null
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'icon',
            title: g.hidden ? 'Show this texture' : 'Hide this texture and its 3D parts',
            'aria-label': g.hidden ? `Show ${g.label}` : `Hide ${g.label}`,
            'aria-pressed': String(g.hidden),
            onclick: () => manager.setHidden(g, !g.hidden),
          },
          icon(g.hidden ? 'eyeOff' : 'eye')
        )
      ),
      g.open ? details(g) : null
    );
  }

  function render() {
    const keep = list.scrollTop;
    const q = filter.value.trim().toLowerCase();
    const shown = manager.groups.filter((g) => !q || g.label.toLowerCase().includes(q) || g.matNames.some((n) => n.toLowerCase().includes(q)));
    count.textContent = manager.groups.length ? `${manager.groups.length} texture${manager.groups.length === 1 ? '' : 's'}` : '';
    showAllBtn.hidden = !manager.groups.some((g) => g.hidden);
    list.replaceChildren(...(manager.groups.length ? shown.map(row) : [empty]));
    list.scrollTop = keep;
  }

  filter.addEventListener('input', render);
  showAllBtn.addEventListener('click', () => manager.showAll());
  manager.onChange(render);
  render();
  return { render };
}
