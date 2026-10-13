// Atalhos no formato "Ctrl+Shift+Code" (KeyboardEvent.code). Ctrl também aceita Cmd no macOS.
export const defaultBindings = {
  pause: ['Space'],
  undo: ['Ctrl+KeyZ'],
  redo: ['Ctrl+KeyY', 'Ctrl+Shift+KeyZ'],
  zoomIn: ['Equal', 'Shift+Equal', 'NumpadAdd'],
  zoomOut: ['Minus', 'NumpadSubtract'],
  zoomReset: ['Digit0', 'Numpad0'],
  rotateLeft: ['KeyQ'],
  rotateRight: ['KeyE'],
  save: ['Ctrl+KeyS'],
  help: ['KeyH'],
  quickStitch: ['KeyB'],
  // color1 a color9: cores do fio, na ordem da paleta.
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`color${n}`, [`Digit${n}`, `Numpad${n}`]])),
};

const REPEATABLE = new Set(['zoomIn', 'zoomOut', 'rotateLeft', 'rotateRight', 'undo', 'redo', 'quickStitch']);

const HOLD_KEY = 'Shift';
const CLICK_SLOP = 5;
const ROTATE_PER_PIXEL = 0.012;

function comboOf(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(event.code);
  return parts.join('+');
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Traduz eventos do navegador em intenções do jogo. `handler` recebe:
 * pointerMove(sx, sy), primary(sx, sy), rotate(radians), contextAction(),
 * zoom(sx, sy, factor), pan(dsx, dsy), setHolding(bool) e action(name).
 */
export class Controls {
  constructor(canvas, handler, bindings = defaultBindings) {
    this.canvas = canvas;
    this.handler = handler;
    this.actionsByCombo = new Map();
    for (const [action, combos] of Object.entries(bindings)) {
      for (const combo of combos) this.actionsByCombo.set(combo, action);
    }
    this.drag = null;
    this.holding = false;

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', () => this.cancelDrag());
    canvas.addEventListener('lostpointercapture', () => this.cancelDrag());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => {
      this.setHolding(false);
      this.cancelDrag();
    });
  }

  localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  onPointerDown(event) {
    this.canvas.focus({ preventScroll: true });
    const p = this.localPoint(event);
    this.handler.pointerMove(p.x, p.y);

    if (event.button === 0) {
      this.handler.primary(p.x, p.y);
    } else if (event.button === 1 || event.button === 2) {
      event.preventDefault();
      this.drag = { button: event.button, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false };
      this.canvas.setPointerCapture(event.pointerId);
      if (event.button === 1) this.canvas.classList.add('is-panning');
    }
  }

  onPointerMove(event) {
    const p = this.localPoint(event);
    const drag = this.drag;

    if (drag) {
      const dx = p.x - drag.lastX;
      const dy = p.y - drag.lastY;
      drag.lastX = p.x;
      drag.lastY = p.y;
      if (Math.hypot(p.x - drag.startX, p.y - drag.startY) > CLICK_SLOP) drag.moved = true;

      if (drag.button === 1) {
        this.handler.pan(dx, dy);
        return;
      }
      if (drag.moved) {
        this.handler.rotate(dx * ROTATE_PER_PIXEL);
        return;
      }
    }

    this.handler.pointerMove(p.x, p.y);
  }

  onPointerUp(event) {
    const drag = this.drag;
    if (!drag || event.button !== drag.button) return;
    if (drag.button === 2 && !drag.moved) this.handler.contextAction();
    this.cancelDrag();
  }

  cancelDrag() {
    this.drag = null;
    this.canvas.classList.remove('is-panning');
  }

  onWheel(event) {
    event.preventDefault();
    const p = this.localPoint(event);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const delta = Math.max(-200, Math.min(200, event.deltaY * unit));
    this.handler.zoom(p.x, p.y, Math.exp(-delta * 0.0018));
  }

  onKeyDown(event) {
    if (document.querySelector('dialog[open]')) return;
    const action = this.actionsByCombo.get(comboOf(event));
    // Salvar continua funcionando com o foco no nome do projeto; os demais atalhos não.
    if (isTypingTarget(event.target) && action !== 'save') return;

    if (event.key === HOLD_KEY) {
      this.setHolding(true);
      return;
    }

    if (!action) return;
    // Espaço e Enter em um botão focado continuam acionando o botão.
    if (event.code === 'Space' && event.target instanceof HTMLButtonElement) return;

    event.preventDefault();
    if (!event.repeat || REPEATABLE.has(action)) this.handler.action(action);
  }

  onKeyUp(event) {
    if (event.key === HOLD_KEY) this.setHolding(false);
  }

  setHolding(holding) {
    if (holding === this.holding) return;
    this.holding = holding;
    this.handler.setHolding(holding);
  }
}
