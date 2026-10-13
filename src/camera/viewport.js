import { clamp, damp } from '../core/math.js';

export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 4;

// Câmera 2D: `x`/`y` é o ponto do mundo no centro da tela.
export class Viewport {
  constructor() {
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.targetZoom = 1;
    this.anchor = null;
  }

  resize(width, height, dpr) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }

  toWorld(sx, sy) {
    return {
      x: this.x + (sx - this.width / 2) / this.zoom,
      y: this.y + (sy - this.height / 2) / this.zoom,
    };
  }

  toScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.width / 2,
      y: (wy - this.y) * this.zoom + this.height / 2,
    };
  }

  // Mantém fixo, durante a transição, o ponto do mundo que estava sob (sx, sy).
  zoomAt(sx, sy, factor) {
    this.targetZoom = clamp(this.targetZoom * factor, MIN_ZOOM, MAX_ZOOM);
    const world = this.toWorld(sx, sy);
    this.anchor = { sx, sy, wx: world.x, wy: world.y };
  }

  zoomTo(zoom) {
    this.zoomAt(this.width / 2, this.height / 2, zoom / this.targetZoom);
  }

  panBy(dsx, dsy) {
    this.anchor = null;
    this.zoom = this.targetZoom;
    this.x -= dsx / this.zoom;
    this.y -= dsy / this.zoom;
  }

  update(dt) {
    if (!this.anchor) return;
    const settled = Math.abs(this.zoom - this.targetZoom) < 1e-4;
    this.zoom = settled ? this.targetZoom : damp(this.zoom, this.targetZoom, 14, dt);
    this.x = this.anchor.wx - (this.anchor.sx - this.width / 2) / this.zoom;
    this.y = this.anchor.wy - (this.anchor.sy - this.height / 2) / this.zoom;
    if (settled) this.anchor = null;
  }

  applyTransform(ctx) {
    const scale = this.zoom * this.dpr;
    ctx.setTransform(
      scale, 0, 0, scale,
      (this.width / 2 - this.x * this.zoom) * this.dpr,
      (this.height / 2 - this.y * this.zoom) * this.dpr,
    );
  }

  visibleBounds(margin = 0) {
    const topLeft = this.toWorld(-margin, -margin);
    const bottomRight = this.toWorld(this.width + margin, this.height + margin);
    return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
  }
}
