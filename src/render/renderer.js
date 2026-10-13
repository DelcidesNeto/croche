import { TAU, clamp, dist, lerp } from '../core/math.js';
import { cellCenter } from '../crochet/tapestry.js';
import { STATE } from '../crochet/work.js';
import { loopRadii } from '../sim/loops.js';
import { shade } from './color.js';
import { FabricLayer, knotId, knotTail, paintLoops, paintStrands } from './fabric.js';

const TABLE_TOP = '#d3dcc7';
const TABLE_BOTTOM = '#b3c2a6';
const ACCENT = '#e0a325';
const ALERT = '#b8452f';
const MAX_LAYERED_CROSSINGS = 300;
const FONT = '"Bricolage Grotesque", "Segoe UI Variable Display", "Trebuchet MS", sans-serif';

// Curva Catmull-Rom convertida em Béziers cúbicas, passando por todos os pontos do intervalo.
function smoothPath(points, from = 0, to = points.length - 1) {
  const path = new Path2D();
  if (to - from < 1) return path;
  path.moveTo(points[from].x, points[from].y);
  for (let i = from; i < to; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    path.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y,
    );
  }
  return path;
}

// Pequenos traços diagonais ao longo do fio que sugerem a torção das fibras.
function twistPath(points, from, to, thickness) {
  const path = new Path2D();
  const spacing = thickness * 0.8;
  const half = thickness * 0.46;
  const tilt = Math.PI / 3;
  let carry = 0;
  for (let i = from; i < to; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    const tx = (ux * cos - uy * sin) * half;
    const ty = (ux * sin + uy * cos) * half;
    let s = spacing - carry;
    while (s <= len) {
      const x = a.x + ux * s;
      const y = a.y + uy * s;
      path.moveTo(x - tx, y - ty);
      path.lineTo(x + tx, y + ty);
      s += spacing;
    }
    carry = len - (s - spacing);
  }
  return path;
}

function linenPattern(ctx) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 24;
  const t = tile.getContext('2d');
  t.strokeStyle = 'rgba(40, 70, 50, 0.07)';
  t.lineWidth = 1;
  for (let i = 0; i < 24; i += 3) {
    t.beginPath();
    t.moveTo(0, i + 0.5);
    t.lineTo(24, i + 0.5);
    t.stroke();
  }
  t.strokeStyle = 'rgba(255, 255, 255, 0.09)';
  for (let i = 0; i < 24; i += 4) {
    t.beginPath();
    t.moveTo(i + 0.5, 0);
    t.lineTo(i + 0.5, 24);
    t.stroke();
  }
  return ctx.createPattern(tile, 'repeat');
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pattern = linenPattern(this.ctx);
    this.candidateAges = [];
    this.fabric = new FabricLayer();
  }

  resize(width, height, dpr) {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  render(scene, dt) {
    const { ctx } = this;
    const { viewport, work } = scene;

    this.drawTable(viewport);
    if (scene.tapestry) {
      viewport.applyTransform(ctx);
      this.drawTapestryGrid(scene.tapestry, viewport.zoom);
    }
    this.fabric.draw(ctx, work, viewport);
    viewport.applyTransform(ctx);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    this.drawSpareBalls(scene.ball, scene.spares);
    this.drawBall(scene.ball, scene.style, scene.yarn.fed);
    this.drawLoopCandidates(scene.yarn.loopCandidates, scene.style.thickness, dt);
    if (scene.tapestry) this.drawNextCell(scene.tapestry, viewport.zoom, scene.time);
    this.drawLoopHighlights(work, scene.hover, viewport.zoom, scene.time);
    this.drawYarn(scene.yarn, scene.style);
    this.drawHookEdges(work);
    this.drawReach(scene.reach, scene.style, viewport.zoom, scene.time);
    this.drawNeedle(scene.needle);
    this.drawHookLoops(work);
    if (scene.pullGuide) this.drawPullGuide(scene.pullGuide, viewport.zoom);
    this.drawEffects(scene.effects, viewport.zoom);
    this.drawTarget(scene.needle, viewport.zoom);

    if (scene.paused) this.drawPaused(viewport);
  }

  drawTable(viewport) {
    const { ctx } = this;
    const { width, height, dpr } = viewport;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const base = ctx.createLinearGradient(0, 0, width * 0.3, height);
    base.addColorStop(0, TABLE_TOP);
    base.addColorStop(1, TABLE_BOTTOM);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);

    // A trama some aos poucos ao afastar, antes de virar faixas (moiré).
    const weave = clamp((viewport.zoom - 0.45) / 0.35, 0, 1);
    if (weave > 0) {
      viewport.applyTransform(ctx);
      const b = viewport.visibleBounds(10);
      ctx.globalAlpha = weave;
      ctx.fillStyle = this.pattern;
      ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      ctx.globalAlpha = 1;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vignette = ctx.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.35,
      width / 2, height / 2, Math.max(width, height) * 0.75,
    );
    vignette.addColorStop(0, 'rgba(30, 50, 35, 0)');
    vignette.addColorStop(1, 'rgba(30, 50, 35, 0.22)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }

  drawBall(ball, style, fed) {
    const { ctx } = this;
    const { x, y, radius: r } = ball;
    const color = style.color;

    ctx.fillStyle = 'rgba(20, 35, 25, 0.22)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.18, y + r * 0.32, r * 1.02, r * 0.92, 0, 0, TAU);
    ctx.fill();

    const body = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    body.addColorStop(0, shade(color, 0.25));
    body.addColorStop(0.7, color);
    body.addColorStop(1, shade(color, -0.35));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();

    // Voltas de fio enroladas; giram conforme o novelo solta linha.
    const spin = fed / (r * 6);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r - 0.5, 0, TAU);
    ctx.clip();
    ctx.lineWidth = Math.max(1.5, style.thickness * 0.55);
    for (let i = 0; i < 16; i++) {
      const angle = i * 1.94 + spin * (i % 2 ? 1 : -0.6);
      ctx.strokeStyle = i % 3 === 0 ? shade(color, 0.3, 0.45) : shade(color, -0.4, 0.4);
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.98, r * (0.25 + (i % 5) * 0.16), angle, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Novelos já usados na peça ficam ao lado, menores.
  drawSpareBalls(ball, spares) {
    const { ctx } = this;
    const r = 13;
    spares.forEach((style, i) => {
      const x = ball.x - ball.radius - 22 - i * (r * 2 + 6);
      const y = ball.y + ball.radius * 0.75;
      ctx.fillStyle = 'rgba(20, 35, 25, 0.2)';
      ctx.beginPath();
      ctx.ellipse(x + r * 0.2, y + r * 0.35, r, r * 0.9, 0, 0, TAU);
      ctx.fill();
      const body = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
      body.addColorStop(0, shade(style.color, 0.25));
      body.addColorStop(1, shade(style.color, -0.35));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = shade(style.color, -0.4, 0.45);
      ctx.lineWidth = Math.max(1, style.thickness * 0.35);
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.95, r * 0.45, 0.6, 0, TAU);
      ctx.stroke();
    });
  }

  // Casas da tapeçaria: as carreiras já começadas e a próxima, por baixo da peça.
  drawTapestryGrid({ grid, next }, zoom) {
    const { ctx } = this;
    const { width: w, height: h, columns } = grid;
    const rows = next.row + 1;
    const left = grid.x0 - w / 2;
    const bottom = grid.y0 + h / 2;
    ctx.beginPath();
    for (let c = 0; c <= columns; c++) {
      ctx.moveTo(left + c * w, bottom);
      ctx.lineTo(left + c * w, bottom - rows * h);
    }
    for (let r = 0; r <= rows; r++) {
      ctx.moveTo(left, bottom - r * h);
      ctx.lineTo(left + columns * w, bottom - r * h);
    }
    ctx.strokeStyle = 'rgba(29, 58, 48, 0.16)';
    ctx.lineWidth = 1 / zoom;
    ctx.stroke();
  }

  drawNextCell({ grid, next }, zoom, time) {
    const { ctx } = this;
    const { x, y } = cellCenter(grid, next.col, next.row);
    const inset = 2 / zoom;
    ctx.setLineDash([5 / zoom, 4 / zoom]);
    ctx.lineDashOffset = -time * 12 / zoom;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2 / zoom;
    ctx.strokeRect(x - grid.width / 2 + inset, y - grid.height / 2 + inset, grid.width - inset * 2, grid.height - inset * 2);
    ctx.setLineDash([]);
  }

  // Laçadas onde a agulha pode entrar ficam realçadas; a laçada com a agulha inserida, mais ainda.
  drawLoopHighlights(work, hover, zoom, time) {
    const { ctx } = this;
    const inserted = work.loops.get(work.inserted);
    const ring = (loop, grow) => {
      const { rx, ry } = loopRadii(loop);
      ctx.beginPath();
      ctx.ellipse(loop.x, loop.y, rx + grow, ry + grow, loop.angle, 0, TAU);
    };

    if (hover && hover !== inserted) {
      ring(hover, hover.thickness * 0.5 + 2 / zoom);
      ctx.setLineDash([5 / zoom, 4 / zoom]);
      ctx.lineDashOffset = -time * 12 / zoom;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2 / zoom;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (inserted) {
      ring(inserted, 0);
      ctx.fillStyle = 'rgba(255, 249, 228, 0.45)';
      ctx.fill();
      ctx.strokeStyle = `rgba(224, 163, 37, ${0.45 + 0.15 * Math.sin(time * 5)})`;
      ctx.lineWidth = inserted.thickness + 7;
      ctx.stroke();
    }
  }

  drawHookEdges(work) {
    const strands = [];
    for (const edge of work.graph.edges) {
      const from = work.loops.get(edge.from);
      const to = work.loops.get(edge.to);
      if (from.state === STATE.ON_HOOK || to.state === STATE.ON_HOOK) strands.push({ a: from, b: to, look: from });
    }
    const knot = work.loops.get(knotId(work));
    if (knot?.state === STATE.ON_HOOK) strands.push(knotTail(knot));
    paintStrands(this.ctx, strands);
  }

  // Laçadas na agulha, desenhadas sobre a haste.
  drawHookLoops(work) {
    paintLoops(this.ctx, work.hook.map((id) => work.loops.get(id)));
  }

  // Trilho ao longo da haste: cada marco é uma laçada que a volta da garganta vai atravessar.
  drawPullGuide(guide, zoom) {
    const { ctx } = this;
    const last = guide.marks[guide.marks.length - 1];
    ctx.setLineDash([4 / zoom, 5 / zoom]);
    ctx.strokeStyle = 'rgba(29, 58, 48, 0.45)';
    ctx.lineWidth = 1.5 / zoom;
    ctx.beginPath();
    ctx.moveTo(guide.x, guide.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = `600 ${10 / zoom}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    guide.marks.forEach((mark, j) => {
      ctx.beginPath();
      ctx.arc(mark.x, mark.y, 6 / zoom, 0, TAU);
      ctx.fillStyle = mark.passed ? ACCENT : 'rgba(247, 250, 243, 0.9)';
      ctx.fill();
      ctx.strokeStyle = '#1d3a30';
      ctx.lineWidth = 1.2 / zoom;
      ctx.stroke();
      ctx.fillStyle = '#1d3a30';
      ctx.fillText(String(j + 1), mark.x, mark.y + 0.5 / zoom);
    });
    ctx.textBaseline = 'alphabetic';
  }

  drawYarn(yarn, style) {
    const { ctx } = this;
    const pts = yarn.points;
    const t = style.thickness;
    const last = pts.length - 1;
    const path = smoothPath(pts);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (style.material.fuzz > 0) {
      ctx.strokeStyle = shade(style.color, 0.35, 0.22 * style.material.fuzz);
      ctx.lineWidth = t * 1.6;
      ctx.stroke(path);
    }

    ctx.save();
    ctx.translate(t * 0.35, t * 0.55);
    ctx.strokeStyle = 'rgba(20, 35, 25, 0.12)';
    ctx.lineWidth = t * 1.35;
    ctx.stroke(path);
    ctx.strokeStyle = 'rgba(20, 35, 25, 0.16)';
    ctx.lineWidth = t;
    ctx.stroke(path);
    ctx.restore();

    this.strokeYarnBody(path, pts, 0, last, style);

    // Nos cruzamentos, o trecho de cima é redesenhado com sombra própria para mostrar profundidade.
    const crossings = yarn.crossings;
    for (let n = 0; n < Math.min(crossings.length, MAX_LAYERED_CROSSINGS); n++) {
      const c = crossings[n];
      const from = Math.max(0, c.over - 3);
      const to = Math.min(last, c.over + 4);
      const piece = smoothPath(pts, from, to);
      ctx.save();
      ctx.translate(t * 0.3, t * 0.45);
      ctx.strokeStyle = 'rgba(20, 35, 25, 0.28)';
      ctx.lineWidth = t * 1.05;
      ctx.stroke(piece);
      ctx.restore();
      this.strokeYarnBody(piece, pts, from, to, style);
    }
  }

  strokeYarnBody(path, pts, from, to, style) {
    const { ctx } = this;
    const t = style.thickness;
    const { twist, sheen } = style.material;

    ctx.strokeStyle = style.color;
    ctx.lineWidth = t;
    ctx.stroke(path);

    ctx.strokeStyle = shade(style.color, -0.45, twist);
    ctx.lineWidth = Math.max(0.6, t * 0.16);
    ctx.lineCap = 'butt';
    ctx.stroke(twistPath(pts, from, to, t));
    ctx.lineCap = 'round';

    ctx.save();
    ctx.translate(-t * 0.16, -t * 0.2);
    ctx.strokeStyle = shade(style.color, 0.55, sheen);
    ctx.lineWidth = t * 0.28;
    ctx.stroke(path);
    ctx.restore();
  }

  drawLoopCandidates(candidates, thickness, dt) {
    const { ctx } = this;
    const previous = this.candidateAges;
    const next = [];

    for (const c of candidates) {
      const match = previous.find((p) => dist(p.x, p.y, c.x, c.y) < 14);
      const age = (match ? match.age : 0) + dt;
      next.push({ x: c.x, y: c.y, age });

      const appear = clamp(age / 0.35, 0, 1);
      const pulse = Math.max(0, 1 - age / 0.6);
      ctx.beginPath();
      ctx.moveTo(c.outline[0].x, c.outline[0].y);
      for (let i = 1; i < c.outline.length; i++) ctx.lineTo(c.outline[i].x, c.outline[i].y);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 249, 228, ${0.55 * appear + 0.35 * pulse})`;
      ctx.fill();
      ctx.lineWidth = thickness + 8;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(224, 163, 37, ${0.5 * appear + 0.4 * pulse})`;
      ctx.stroke();
    }

    this.candidateAges = next;
  }

  drawReach(reach, style, zoom, time) {
    if (!reach) return;
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(time * 6);
    ctx.beginPath();
    ctx.arc(reach.x, reach.y, style.thickness * 0.9 + (3 + pulse * 2) / zoom, 0, TAU);
    ctx.lineWidth = 2 / zoom;
    ctx.strokeStyle = reach.hooked ? 'rgba(255, 255, 255, 0.85)' : ACCENT;
    ctx.stroke();
  }

  drawEffects(effects, zoom) {
    const { ctx } = this;
    for (const e of effects) {
      const k = e.age / e.life;
      if (e.kind === 'label') {
        this.drawLabel(e, k, zoom);
        continue;
      }
      if (e.kind === 'shrink') {
        // A volta de fio se fecha em torno da garganta, virando a laçada inicial.
        const s = (1 - k) ** 2;
        ctx.globalAlpha = 1 - k;
        ctx.beginPath();
        e.outline.forEach((p, i) => {
          const x = lerp(e.x, p.x, s);
          const y = lerp(e.y, p.y, s);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 3 / zoom;
        ctx.stroke();
        continue;
      }
      const color = e.kind === 'alert' ? ALERT : e.kind === 'cross' ? '#ffffff' : ACCENT;
      ctx.globalAlpha = 1 - k;
      ctx.beginPath();
      ctx.arc(e.x, e.y, (6 + k * 22) / zoom, 0, TAU);
      ctx.lineWidth = (3 - k * 2) / zoom;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawLabel(e, k, zoom) {
    const { ctx } = this;
    const y = e.y - (22 + k * 26) / zoom;
    ctx.globalAlpha = 1 - k * k;
    ctx.font = `600 ${14 / zoom}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 4 / zoom;
    ctx.strokeStyle = 'rgba(247, 250, 243, 0.9)';
    ctx.strokeText(e.text, e.x, y);
    ctx.fillStyle = e.alert ? ALERT : '#1d3a30';
    ctx.fillText(e.text, e.x, y);
    ctx.globalAlpha = 1;
  }

  drawNeedle(needle) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(needle.x + 7, needle.y + 11);
    ctx.rotate(needle.angle);
    ctx.fillStyle = 'rgba(20, 35, 25, 0.2)';
    this.needleSilhouette();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(needle.x, needle.y);
    ctx.rotate(needle.angle);

    // Haste de alumínio com gancho na ponta.
    const metal = ctx.createLinearGradient(0, -3, 0, 3);
    metal.addColorStop(0, '#6f8894');
    metal.addColorStop(0.3, '#e4eef2');
    metal.addColorStop(0.65, '#a3b7c0');
    metal.addColorStop(1, '#55707c');
    ctx.fillStyle = metal;
    ctx.beginPath();
    ctx.moveTo(3, -2.8);
    ctx.lineTo(96, -2.8);
    ctx.quadraticCurveTo(104, -5, 112, -5);
    ctx.lineTo(132, -5);
    ctx.lineTo(132, 5);
    ctx.lineTo(112, 5);
    ctx.quadraticCurveTo(104, 5, 96, 2.8);
    ctx.lineTo(3, 2.8);
    ctx.arc(3, 0, 2.8, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.fill();

    // Garganta do gancho, onde a linha fica presa.
    ctx.strokeStyle = 'rgba(30, 45, 55, 0.85)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(1.2, -2.2);
    ctx.quadraticCurveTo(5.5, -0.2, 12.5, -2.6);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(2.2, -1.2);
    ctx.quadraticCurveTo(5.5, 0.6, 11, -1.4);
    ctx.stroke();

    // Apoio para o polegar, achatado.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillRect(106, -3.6, 22, 1.6);

    // Cabo emborrachado.
    const grip = ctx.createLinearGradient(0, -6.5, 0, 6.5);
    grip.addColorStop(0, '#3c7560');
    grip.addColorStop(0.35, '#2a5a48');
    grip.addColorStop(1, '#16352a');
    ctx.fillStyle = grip;
    ctx.beginPath();
    ctx.moveTo(130, -6.5);
    ctx.lineTo(228, -6);
    ctx.arc(228, 0, 6, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(130, 6.5);
    ctx.quadraticCurveTo(126, 0, 130, -6.5);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(134, -4.6, 92, 1.8);

    ctx.restore();
  }

  needleSilhouette() {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(3, -2.8);
    ctx.lineTo(112, -5);
    ctx.lineTo(228, -6.5);
    ctx.arc(228, 0, 6.5, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(112, 5);
    ctx.lineTo(3, 2.8);
    ctx.arc(3, 0, 2.8, Math.PI / 2, (Math.PI * 3) / 2);
  }

  // Marca discreta da posição real do mouse, já que a agulha segue com suavidade.
  drawTarget(needle, zoom) {
    const gap = dist(needle.x, needle.y, needle.targetX, needle.targetY) * zoom;
    if (gap < 4) return;
    const { ctx } = this;
    ctx.globalAlpha = clamp(gap / 30, 0, 0.6);
    ctx.fillStyle = '#1d3a30';
    ctx.beginPath();
    ctx.arc(needle.targetX, needle.targetY, 2.5 / zoom, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawPaused(viewport) {
    const { ctx } = this;
    const { width, height, dpr } = viewport;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(29, 58, 48, 0.25)';
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f7faf3';
    ctx.font = `800 44px ${FONT}`;
    ctx.fillText('Pausado', width / 2, height / 2);
    ctx.font = `400 16px ${FONT}`;
    ctx.fillText('Pressione Espaço para continuar', width / 2, height / 2 + 30);
  }
}
