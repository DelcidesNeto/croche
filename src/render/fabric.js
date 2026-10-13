import { TAU, wrapAngle } from '../core/math.js';
import { STATE } from '../crochet/work.js';
import { loopRadii } from '../sim/loops.js';
import { materialById } from '../sim/materials.js';
import { shade } from './color.js';

const SHADOW = 'rgba(20, 35, 25, 0.2)';
const KNOT_TAIL = 30;
// Folga em volta das laçadas para sombras, ligações curvas e a ponta solta não serem cortadas.
const PIECE_PAD = 50;
// Quanto além da tela o cache cobre, em fração do tamanho da tela, para mover a câmera sem redesenhar.
const CACHE_MARGIN = 0.25;
// Espaço reservado em volta da peça para as próximas laçadas entrarem sem redesenhar tudo.
const GROWTH_PAD = 150;
// Ângulos e tamanhos arredondados para reaproveitar o desenho de laçadas parecidas.
const ANGLE_STEP = TAU / 64;
const SIZE_STEP = 0.5;

// Agrupa por fio (cor, espessura e material): cada grupo é desenhado com poucos traços, não um por laçada.
function byLook(items, lookOf) {
  const groups = new Map();
  for (const item of items) {
    const look = lookOf(item);
    const key = `${look.color}|${look.thickness}|${look.materialId}`;
    let group = groups.get(key);
    if (!group) {
      group = { look, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return groups.values();
}

// Anéis de fio com sombra, torção e brilho, na cor e no material com que cada laçada foi feita.
export function paintLoops(ctx, loops) {
  for (const { look, items } of byLook(loops, (loop) => loop)) {
    const t = look.thickness;
    const material = materialById(look.materialId);
    const rings = (ox, oy) => {
      ctx.beginPath();
      for (const loop of items) {
        const { rx, ry } = loopRadii(loop);
        const x = loop.x + ox;
        const y = loop.y + oy;
        ctx.moveTo(x + rx * Math.cos(loop.angle), y + rx * Math.sin(loop.angle));
        ctx.ellipse(x, y, rx, ry, loop.angle, 0, TAU);
      }
    };

    if (material.fuzz > 0) {
      rings(0, 0);
      ctx.strokeStyle = shade(look.color, 0.35, 0.22 * material.fuzz);
      ctx.lineWidth = t * 1.6;
      ctx.stroke();
    }
    rings(t * 0.3, t * 0.45);
    ctx.strokeStyle = SHADOW;
    ctx.lineWidth = t * 1.05;
    ctx.stroke();

    rings(0, 0);
    ctx.strokeStyle = look.color;
    ctx.lineWidth = t;
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.setLineDash([t * 0.16, t * 0.64]);
    ctx.strokeStyle = shade(look.color, -0.45, material.twist);
    ctx.lineWidth = t * 0.85;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = 'round';

    rings(-t * 0.16, -t * 0.2);
    ctx.strokeStyle = shade(look.color, 0.55, material.sheen);
    ctx.lineWidth = t * 0.28;
    ctx.stroke();
  }
}

/**
 * Trechos de fio entre laçadas: `{ a, b, look }` liga a laçada nova (`a`) à laçada pela qual ela passou.
 * Levemente curvos, como o fio acomodado.
 */
export function paintStrands(ctx, strands) {
  for (const { look, items } of byLook(strands, (s) => s.look)) {
    const t = look.thickness * 0.8;
    const curves = (ox, oy) => {
      ctx.beginPath();
      for (const { a, b } of items) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 2) continue;
        const bend = Math.min(len * 0.18, 10);
        ctx.moveTo(a.x + ox, a.y + oy);
        ctx.quadraticCurveTo((a.x + b.x) / 2 - (dy / len) * bend + ox, (a.y + b.y) / 2 + (dx / len) * bend + oy, b.x + ox, b.y + oy);
      }
    };

    curves(t * 0.3, t * 0.45);
    ctx.strokeStyle = SHADOW;
    ctx.lineWidth = t * 1.05;
    ctx.stroke();
    curves(0, 0);
    ctx.strokeStyle = shade(look.color, -0.12);
    ctx.lineWidth = t;
    ctx.stroke();
  }
}

// Ponta solta que sobra da laçada inicial.
export function knotTail(loop) {
  const dir = loop.angle + 2.3;
  const { rx } = loopRadii(loop);
  const a = { x: loop.x + Math.cos(dir) * rx, y: loop.y + Math.sin(dir) * rx };
  const b = { x: a.x + Math.cos(dir) * KNOT_TAIL, y: a.y + Math.sin(dir) * KNOT_TAIL };
  return { a, b, look: loop };
}

export function knotId(work) {
  const first = work.log[0];
  return first?.type === 'inicial' ? first.loop : null;
}

function pieceBounds(work) {
  let bounds = null;
  for (const loop of work.closedLoops()) {
    bounds ??= { minX: loop.x, minY: loop.y, maxX: loop.x, maxY: loop.y };
    bounds.minX = Math.min(bounds.minX, loop.x);
    bounds.minY = Math.min(bounds.minY, loop.y);
    bounds.maxX = Math.max(bounds.maxX, loop.x);
    bounds.maxY = Math.max(bounds.maxY, loop.y);
  }
  if (!bounds) return null;
  return { minX: bounds.minX - PIECE_PAD, minY: bounds.minY - PIECE_PAD, maxX: bounds.maxX + PIECE_PAD, maxY: bounds.maxY + PIECE_PAD };
}

function intersect(a, b) {
  const r = { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) };
  return r.minX < r.maxX && r.minY < r.maxY ? r : null;
}

function contains(outer, inner) {
  return outer && inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY;
}

/**
 * Laçadas fechadas desenhadas a partir de imagens prontas, uma por fio, tamanho, ângulo e escala:
 * milhares de anéis viram milhares de cópias de imagem em vez de milhares de traços vetoriais.
 */
class LoopStamps {
  constructor() {
    this.scale = 0;
    this.stamps = new Map();
  }

  // `ctx` sem transformação: a imagem é copiada pixel a pixel, na posição já convertida para a tela do cache.
  draw(ctx, loop, scale, rect) {
    if (scale !== this.scale) {
      this.stamps.clear();
      this.scale = scale;
    }
    const angle = Math.round(wrapAngle(loop.angle) / ANGLE_STEP) * ANGLE_STEP;
    const size = Math.round(loop.size / SIZE_STEP) * SIZE_STEP;
    const key = `${loop.color}|${loop.thickness}|${loop.materialId}|${size}|${angle}`;
    let stamp = this.stamps.get(key);
    if (!stamp) {
      stamp = this.build({ ...loop, x: 0, y: 0, angle, size }, scale);
      this.stamps.set(key, stamp);
    }
    const center = stamp.half * scale;
    ctx.drawImage(stamp.canvas, Math.round((loop.x - rect.minX) * scale - center), Math.round((loop.y - rect.minY) * scale - center));
  }

  build(loop, scale) {
    const { rx, ry } = loopRadii(loop);
    const half = Math.max(rx, ry) + loop.thickness * 1.3 + 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.ceil(half * 2 * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, half * scale, half * scale);
    ctx.lineCap = 'round';
    paintLoops(ctx, [loop]);
    return { canvas, half };
  }
}

function paddedBox(loop) {
  return { minX: loop.x - PIECE_PAD, minY: loop.y - PIECE_PAD, maxX: loop.x + PIECE_PAD, maxY: loop.y + PIECE_PAD };
}

/**
 * Laçadas fechadas não mudam mais: ficam numa imagem à parte, que cobre a parte visível da peça com folga.
 * Laçadas recém-fechadas são acrescentadas por cima; desfazer, assentar o zoom ou sair da área coberta
 * redesenha tudo. Mover a câmera só desloca a imagem; durante a animação do zoom ela é escalada.
 */
export class FabricLayer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.work = null;
    this.version = -1;
    this.boundsVersion = -1;
    this.bounds = null;
    this.rect = null;
    this.closed = new Set();
    this.stamps = new LoopStamps();
    this.zoom = 0;
    this.dpr = 0;
  }

  paintClosedLoops(loops) {
    const scale = this.zoom * this.dpr;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const loop of loops) this.stamps.draw(this.ctx, loop, scale, this.rect);
    this.applyTransform();
  }

  draw(target, work, viewport) {
    // Cada trabalho aberto ou novo recomeça a contagem de versões: comparar só a versão não basta.
    if (work !== this.work) {
      this.work = work;
      this.boundsVersion = -1;
      this.rect = null;
    }
    if (work.version !== this.boundsVersion) {
      this.bounds = pieceBounds(work);
      this.boundsVersion = work.version;
    }
    if (!this.bounds) return;
    const view = intersect(viewport.visibleBounds(0), this.bounds);
    if (!view) return;

    const settled = viewport.anchor === null;
    const moved = viewport.dpr !== this.dpr || (settled && viewport.zoom !== this.zoom) || !contains(this.rect, view);
    if (moved || (work.version !== this.version && !this.append(work))) this.repaint(work, viewport);

    const s = viewport.zoom / this.zoom;
    const corner = viewport.toScreen(this.rect.minX, this.rect.minY);
    let dx = corner.x * viewport.dpr;
    let dy = corner.y * viewport.dpr;
    if (s === 1) {
      dx = Math.round(dx);
      dy = Math.round(dy);
    }
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.drawImage(this.canvas, dx, dy, this.canvas.width * s, this.canvas.height * s);
  }

  // Desenha só as laçadas que acabaram de fechar. Devolve false quando é preciso redesenhar tudo.
  append(work) {
    const closed = new Set();
    for (const loop of work.closedLoops()) closed.add(loop.id);
    for (const id of this.closed) {
      if (!closed.has(id)) return false;
    }
    const added = [];
    for (const id of closed) {
      if (this.closed.has(id)) continue;
      const loop = work.loops.get(id);
      if (!contains(this.rect, paddedBox(loop))) return false;
      added.push(loop);
    }

    if (added.length) {
      const fresh = new Set(added.map((loop) => loop.id));
      const strands = [];
      for (const edge of work.graph.edges) {
        if (!fresh.has(edge.from) && !fresh.has(edge.to)) continue;
        const from = work.loops.get(edge.from);
        const to = work.loops.get(edge.to);
        if (from.state === STATE.CLOSED && to.state === STATE.CLOSED) strands.push({ a: from, b: to, look: from });
      }
      const knot = knotId(work);
      if (fresh.has(knot)) strands.push(knotTail(work.loops.get(knot)));
      this.applyTransform();
      paintStrands(this.ctx, strands);
      this.paintClosedLoops(added);
    }
    this.closed = closed;
    this.version = work.version;
    return true;
  }

  applyTransform() {
    const scale = this.zoom * this.dpr;
    this.ctx.setTransform(scale, 0, 0, scale, -this.rect.minX * scale, -this.rect.minY * scale);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
  }

  repaint(work, viewport) {
    const { canvas, ctx } = this;
    const v = viewport.visibleBounds(0);
    const mx = (viewport.width * CACHE_MARGIN) / viewport.zoom;
    const my = (viewport.height * CACHE_MARGIN) / viewport.zoom;
    const b = this.bounds;
    const room = { minX: b.minX - GROWTH_PAD, minY: b.minY - GROWTH_PAD, maxX: b.maxX + GROWTH_PAD, maxY: b.maxY + GROWTH_PAD };
    const rect = intersect({ minX: v.minX - mx, minY: v.minY - my, maxX: v.maxX + mx, maxY: v.maxY + my }, room);
    const scale = viewport.zoom * viewport.dpr;
    const width = Math.ceil((rect.maxX - rect.minX) * scale);
    const height = Math.ceil((rect.maxY - rect.minY) * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
    }

    this.rect = rect;
    this.zoom = viewport.zoom;
    this.dpr = viewport.dpr;
    this.applyTransform();
    const visible = (loop) => loop.x > rect.minX - PIECE_PAD && loop.x < rect.maxX + PIECE_PAD
      && loop.y > rect.minY - PIECE_PAD && loop.y < rect.maxY + PIECE_PAD;

    const strands = [];
    for (const edge of work.graph.edges) {
      const from = work.loops.get(edge.from);
      const to = work.loops.get(edge.to);
      if (from.state !== STATE.CLOSED || to.state !== STATE.CLOSED) continue;
      if (visible(from) || visible(to)) strands.push({ a: from, b: to, look: from });
    }
    const knot = work.loops.get(knotId(work));
    if (knot?.state === STATE.CLOSED && visible(knot)) strands.push(knotTail(knot));
    paintStrands(ctx, strands);
    const closed = [...work.closedLoops()];
    this.paintClosedLoops(closed.filter(visible));

    this.closed = new Set(closed.map((loop) => loop.id));
    this.version = work.version;
  }
}
