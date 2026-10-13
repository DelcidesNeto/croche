import { MATERIALS, THICKNESSES, YARN_COLORS, noveloKey } from '../sim/materials.js';

const HELP_SEEN_KEY = 'croche-livre:ajuda-vista';
const TOOL_IDS = ['save', 'projects-open', 'tapestry-open', 'undo', 'redo', 'zoom-in', 'zoom-out', 'zoom-reset', 'settings-open', 'help-open', 'account-open'];

function radioGroup(container, items, selectedId, build, onSelect) {
  const buttons = items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.dataset.id = item.id;
    build(button, item);
    button.addEventListener('click', () => {
      select(item.id);
      onSelect(item);
    });
    container.append(button);
    return button;
  });

  function select(id) {
    for (const button of buttons) {
      const checked = button.dataset.id === id;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
  }

  select(selectedId);
  return select;
}

function write(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

export function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function describeNovelo(style) {
  return `${style.colorName}, fio ${style.thicknessName.toLowerCase()}, ${style.material.name.toLowerCase()}`;
}

export function createPanel({ style, onColor, onThickness, onMaterial, onTool, onNovelo, onRename }) {
  const $ = (id) => document.getElementById(id);
  const hint = $('hint');
  const tension = $('tension');
  const zoomReset = $('zoom-reset');
  const help = $('help');
  const projectName = $('project-name');
  const novelos = $('novelos');
  const meta = {
    time: $('meta-time'),
    loops: $('meta-loops'),
    stitches: $('meta-stitches'),
    mode: $('meta-mode'),
    state: $('meta-state'),
    summary: $('meta-summary'),
  };
  let hintText = '';
  let hintTimer = 0;
  let novelosKey = '';

  const selectColor = radioGroup($('swatches'), YARN_COLORS, style.colorId, (button, color) => {
    button.className = 'swatch';
    button.style.setProperty('--swatch', color.value);
    button.title = color.name;
    button.setAttribute('aria-label', color.name);
  }, onColor);

  const selectThickness = radioGroup($('thickness'), THICKNESSES, style.thicknessId, (button, thickness) => {
    button.className = 'thickness-option';
    button.title = `Fio ${thickness.name.toLowerCase()}`;
    button.setAttribute('aria-label', button.title);
    const dot = document.createElement('i');
    dot.style.setProperty('--size', `${thickness.value}px`);
    button.append(dot);
  }, onThickness);

  const material = $('material');
  for (const item of MATERIALS) material.add(new Option(item.name, item.id, false, item.id === style.materialId));
  material.addEventListener('change', () => onMaterial(MATERIALS.find((m) => m.id === material.value)));

  for (const id of TOOL_IDS) $(id).addEventListener('click', () => onTool(id));
  $('novelo-add').addEventListener('click', () => onTool('novelo-add'));

  projectName.addEventListener('input', () => onRename(projectName.value.trim()));
  projectName.addEventListener('change', () => {
    if (!projectName.value.trim()) projectName.value = 'Sem nome';
    onRename(projectName.value.trim());
  });

  return {
    setHint(text, alert = false) {
      if (text === hintText) return;
      hintText = text;
      clearTimeout(hintTimer);
      hint.classList.add('is-changing');
      hintTimer = setTimeout(() => {
        hint.textContent = text;
        hint.classList.toggle('is-alert', alert);
        hint.classList.remove('is-changing');
      }, 160);
    },

    setTension(value) {
      const transform = `scaleX(${value.toFixed(2)})`;
      if (tension.style.transform !== transform) tension.style.transform = transform;
    },

    setMeta({ time, loops, stitches, mode, state, summary }) {
      write(meta.time, formatDuration(time));
      write(meta.loops, String(loops));
      write(meta.stitches, String(stitches));
      write(meta.mode, mode);
      write(meta.state, state);
      write(meta.summary, summary);
    },

    setZoom(zoom) {
      write(zoomReset, `${Math.round(zoom * 100)}%`);
    },

    setHistory({ canUndo, canRedo }) {
      $('undo').disabled = !canUndo;
      $('redo').disabled = !canRedo;
    },

    setProjectName(name) {
      projectName.value = name;
    },

    setUser(name) {
      const account = $('account-open');
      account.hidden = !name;
      $('account-name').textContent = name ?? '';
      account.title = `Conta de ${name}: clique para sair`;
      account.setAttribute('aria-label', account.title);
    },

    selectStyle(next) {
      selectColor(next.colorId);
      selectThickness(next.thicknessId);
      material.value = next.materialId;
    },

    setNovelos(list, active) {
      const key = `${list.map(noveloKey).join(',')}/${noveloKey(active)}`;
      if (key === novelosKey) return;
      novelosKey = key;
      novelos.replaceChildren(...list.map((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'novelo';
        button.classList.toggle('is-active', noveloKey(item) === noveloKey(active));
        button.style.setProperty('--swatch', item.color);
        button.title = describeNovelo(item);
        button.setAttribute('aria-label', `Usar novelo: ${button.title}`);
        button.addEventListener('click', () => onNovelo(item));
        return button;
      }));
    },

    openHelp() {
      if (!help.open) help.showModal();
    },

    // Na primeira visita deste navegador, a ajuda abre sozinha.
    openHelpOnce() {
      if (localStorage.getItem(HELP_SEEN_KEY)) return;
      localStorage.setItem(HELP_SEEN_KEY, '1');
      this.openHelp();
    },
  };
}
