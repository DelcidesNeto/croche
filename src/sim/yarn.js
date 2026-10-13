import { clamp, closestPointOnSegment, lerp, polygonArea, segmentIntersection } from '../core/math.js';

export const SEGMENT = 8;
const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
const ITERATIONS = 14;
const FRICTION = 0.82;
const MIN_BEND = SEGMENT * 1.5;
const BEND_STIFFNESS = 0.3;
const FEED_SLACK = 1.01;
const SLIP_STRETCH = 1.15;
const TENSION_FROM = 0.9;
const MAX_FEED_PER_STEP = SEGMENT * 8;
export const MAX_POINTS = 1500;
const CATCH_BLEND_TIME = 0.12;
const MIN_LOOP_AREA = (SEGMENT * 3) ** 2;
// Uma volta já reconhecida continua valendo ao encolher um pouco (o fio se acomoda ao ser solto).
const KEEP_LOOP_FACTOR = 0.4;
const MAX_LOOP_CANDIDATES = 40;
const GRID_CELL = SEGMENT * 3;
const PAIR_KEY = 2 ** 26;

let nextPointId = 1;

// `id` acompanha o ponto mesmo quando o novelo insere fio e os índices mudam.
function makePoint(x, y) {
  return { id: nextPointId++, x, y, px: x, py: y };
}

/**
 * Fio como corrente de partículas (Verlet) presa ao novelo no índice 0.
 * Sem gravidade: a vista é de cima, com o fio deitado sobre a mesa.
 */
export class Yarn {
  constructor({ anchorX, anchorY, towardX, towardY, count = 52 }) {
    this.anchor = { x: anchorX, y: anchorY };
    this.points = [];
    this.hookIndex = -1;
    this.hookX = 0;
    this.hookY = 0;
    this.catchFrom = null;
    this.catchBlend = 1;
    this.holding = false;
    this.fed = 0;
    this.reelRest = SEGMENT;
    this.stretch = 1;
    this.crossings = [];
    this.layering = new Map();
    this.tested = new Int32Array(MAX_POINTS);
    this.loopCandidates = [];
    this.accumulator = 0;
    this.events = [];
    // Depois da laçada inicial o fio fica preso ao trabalho: não escorrega nem se solta da agulha.
    this.working = false;
    this.lay(towardX, towardY, count);
  }

  static fromSnapshot(snapshot) {
    const { anchor, points } = snapshot ?? {};
    const valid = Array.isArray(points) && points.length >= 2
      && Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y)
      && points.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!valid || points.length > MAX_POINTS || snapshot.hookIndex >= points.length) {
      throw new Error('Fio com dados inválidos');
    }
    const yarn = new Yarn({ anchorX: anchor.x, anchorY: anchor.y, towardX: anchor.x + 1, towardY: anchor.y, count: 2 });
    yarn.restore(snapshot);
    return yarn;
  }

  snapshot() {
    return {
      anchor: { ...this.anchor },
      points: this.points.map((p) => [p.x, p.y]),
      hookIndex: this.hookIndex,
      reelRest: this.reelRest,
      fed: this.fed,
      working: this.working,
    };
  }

  restore(snapshot) {
    this.anchor = { ...snapshot.anchor };
    this.points = snapshot.points.map(([x, y]) => makePoint(x, y));
    this.hookIndex = snapshot.hookIndex;
    this.reelRest = snapshot.reelRest;
    this.fed = snapshot.fed;
    this.working = snapshot.working;
    this.catchFrom = null;
    this.catchBlend = 1;
    this.stretch = 1;
    this.accumulator = 0;
    this.crossings = [];
    this.layering = new Map();
    this.loopCandidates = [];
    if (this.isHooked) {
      const hook = this.points[this.hookIndex];
      this.hookX = hook.x;
      this.hookY = hook.y;
    }
  }

  /**
   * Aperta a volta de fio `candidate` em volta da agulha: o trecho da volta e a ponta solta saem
   * da simulação (passam a ser a laçada inicial) e o fio fica preso ao trabalho, terminando na agulha.
   * Se a linha não estava no gancho, a agulha pega o fio do lado do novelo, no cruzamento.
   * Devolve os estados antes e depois para a operação poder ser desfeita.
   */
  tieKnot(candidate, hookX, hookY) {
    const before = this.snapshot();
    if (this.isHooked) {
      const h = this.hookIndex;
      this.points = this.points.filter((p, i) => i === h || (i < h && (i <= candidate.first || i > candidate.last)));
      this.hookIndex = this.points.length - 1;
    } else {
      this.points = this.points.slice(0, Math.max(candidate.first, 1) + 1);
      this.catchAt(this.points.length - 1, hookX, hookY);
    }
    return this.startWorking(before);
  }

  // Laçada inicial direto no gancho (modo tapeçaria): a ponta solta depois dele vira a laçada.
  tieAtHook() {
    const before = this.snapshot();
    this.points = this.points.slice(0, this.hookIndex + 1);
    return this.startWorking(before);
  }

  startWorking(before) {
    this.working = true;
    this.crossings = [];
    this.layering = new Map();
    this.loopCandidates = [];
    return { before, after: this.snapshot() };
  }

  // O fio que vira laçada sai do trecho entre o novelo e a agulha; se faltar, o novelo solta mais.
  consume(length) {
    this.reelRest -= length;
    while (this.reelRest < SEGMENT * 0.5 && this.hookIndex > 1) {
      this.points.splice(1, 1);
      this.hookIndex -= 1;
      this.reelRest += SEGMENT;
    }
    this.reelRest = Math.max(this.reelRest, SEGMENT * 0.5);
  }

  // Até onde a agulha alcança com o fio segurado, antes de esticar além do limite.
  maxReach() {
    return this.restLength() * SLIP_STRETCH;
  }

  // Deita o fio sobre a mesa com uma ondulação suave, saindo do novelo em direção a (towardX, towardY).
  lay(towardX, towardY, count) {
    const heading = Math.atan2(towardY - this.anchor.y, towardX - this.anchor.x);
    let x = this.anchor.x;
    let y = this.anchor.y;
    this.points = [makePoint(x, y)];
    for (let i = 1; i < count; i++) {
      const angle = heading + Math.sin(i * 0.11) * 0.45;
      x += Math.cos(angle) * SEGMENT;
      y += Math.sin(angle) * SEGMENT;
      this.points.push(makePoint(x, y));
    }
  }

  get isHooked() {
    return this.hookIndex >= 0;
  }

  get tension() {
    if (!this.isHooked) return 0;
    return clamp((this.stretch - TENSION_FROM) / (SLIP_STRETCH - TENSION_FROM), 0, 1);
  }

  nearest(x, y, maxDist) {
    let best = null;
    let bestD2 = maxDist * maxDist;
    const pts = this.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const c = closestPointOnSegment(x, y, a.x, a.y, b.x, b.y);
      if (c.d2 < bestD2) {
        bestD2 = c.d2;
        best = { index: c.t < 0.5 ? i : i + 1, x: c.x, y: c.y, dist: Math.sqrt(c.d2) };
      }
    }
    // O ponto preso ao novelo não pode ser puxado para fora dele.
    if (best && best.index === 0) best.index = 1;
    return best;
  }

  catchAt(index, hookX, hookY) {
    const p = this.points[index];
    this.hookIndex = index;
    this.hookX = hookX;
    this.hookY = hookY;
    this.catchFrom = { x: p.x, y: p.y };
    this.catchBlend = 0;
  }

  release() {
    this.hookIndex = -1;
    this.catchFrom = null;
    this.stretch = 1;
  }

  setHook(x, y) {
    this.hookX = x;
    this.hookY = y;
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  update(dt) {
    this.accumulator = Math.min(this.accumulator + dt, STEP * MAX_STEPS_PER_FRAME);
    let stepped = false;
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.step();
      stepped = true;
    }
    if (stepped) this.findCrossings();
  }

  step() {
    const pts = this.points;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const vx = (p.x - p.px) * FRICTION;
      const vy = (p.y - p.py) * FRICTION;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy;
    }

    if (this.isHooked && this.catchBlend < 1) {
      this.catchBlend = Math.min(1, this.catchBlend + STEP / CATCH_BLEND_TIME);
    }

    if (this.isHooked) {
      this.pin();
      this.dragTail();
    }
    for (let k = 0; k < ITERATIONS; k++) {
      this.pin();
      this.solveBending();
      this.solveLengths(k % 2 === 0);
    }
    this.pin();

    if (this.isHooked) this.pullFromBall();
  }

  pin() {
    const first = this.points[0];
    first.x = first.px = this.anchor.x;
    first.y = first.py = this.anchor.y;

    if (!this.isHooked) return;
    const p = this.points[this.hookIndex];
    if (this.catchBlend >= 1) {
      p.x = this.hookX;
      p.y = this.hookY;
    } else {
      const t = this.catchBlend * this.catchBlend * (3 - 2 * this.catchBlend);
      p.x = lerp(this.catchFrom.x, this.hookX, t);
      p.y = lerp(this.catchFrom.y, this.hookY, t);
    }
    p.px = p.x;
    p.py = p.y;
  }

  inverseMass(i) {
    return i === 0 || i === this.hookIndex ? 0 : 1;
  }

  solveLengths(forward) {
    const pts = this.points;
    const last = pts.length - 2;
    for (let n = 0; n <= last; n++) {
      const i = forward ? n : last - n;
      this.constrain(i, i + 1, i === 0 ? this.reelRest : SEGMENT, 1, false);
    }
  }

  solveBending() {
    const pts = this.points;
    for (let i = 0; i < pts.length - 2; i++) {
      this.constrain(i, i + 2, MIN_BEND, BEND_STIFFNESS, true);
    }
  }

  // Aproxima ou afasta dois pontos até `rest`. Com `pushOnly`, só corrige quando estão perto demais.
  constrain(i, j, rest, stiffness, pushOnly) {
    const a = this.points[i];
    const b = this.points[j];
    const wa = this.inverseMass(i);
    const wb = this.inverseMass(j);
    const w = wa + wb;
    if (w === 0) return;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    if (pushOnly && d >= rest) return;

    const diff = ((d - rest) / (d * w)) * stiffness;
    a.x += dx * diff * wa;
    a.y += dy * diff * wa;
    b.x -= dx * diff * wb;
    b.y -= dy * diff * wb;
  }

  // A ponta solta segue o rastro do gancho, como fio arrastado sobre a mesa (sem ganhar impulso).
  dragTail() {
    const pts = this.points;
    for (let i = this.hookIndex + 1; i < pts.length; i++) {
      const p = pts[i];
      const leader = pts[i - 1];
      const dx = p.x - leader.x;
      const dy = p.y - leader.y;
      const d = Math.hypot(dx, dy);
      if (d <= SEGMENT) break;
      const k = SEGMENT / d;
      const nx = leader.x + dx * k;
      const ny = leader.y + dy * k;
      p.px += nx - p.x;
      p.py += ny - p.y;
      p.x = nx;
      p.y = ny;
    }
  }

  restLength() {
    return this.reelRest + (this.hookIndex - 1) * SEGMENT;
  }

  // Sem obstáculos na mesa, fio esticado entre novelo e gancho é uma reta: comparar a distância reta
  // com o fio disponível diz se há folga, sem depender da convergência do solver.
  pullFromBall() {
    const hook = this.points[this.hookIndex];
    const straight = Math.hypot(hook.x - this.anchor.x, hook.y - this.anchor.y);
    this.stretch = straight / this.restLength();

    if (this.holding) {
      if (this.stretch > SLIP_STRETCH && !this.working) {
        this.release();
        this.events.push({ type: 'slip', x: hook.x, y: hook.y });
      }
      return;
    }
    if (this.stretch <= 1) return;
    if (this.points.length >= MAX_POINTS) {
      this.events.push({ type: 'feed-limit' });
      return;
    }

    // O primeiro segmento funciona como carretel: cresce com o puxão e vira um ponto novo a cada SEGMENT.
    this.reelRest += Math.min(straight * FEED_SLACK - this.restLength(), MAX_FEED_PER_STEP);
    const a = this.points[0];
    while (this.reelRest >= SEGMENT * 2 && this.points.length < MAX_POINTS) {
      const b = this.points[1];
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = Math.max(0, d - SEGMENT) / d;
      this.points.splice(1, 0, makePoint(lerp(a.x, b.x, t), lerp(a.y, b.y, t)));
      this.reelRest -= SEGMENT;
      this.hookIndex += 1;
      this.fed += SEGMENT;
    }
  }

  // Cruzamentos do fio consigo mesmo. Quem fica por cima é decidido quando o cruzamento surge
  // (o trecho carregado pela agulha passa sobre o fio deitado) e mantido enquanto ele existir.
  findCrossings() {
    const pts = this.points;
    const grid = new Map();
    const crossings = [];
    const layering = new Map();
    // tested[j] === i marca que o par (j, i) já foi verificado em outra célula da grade.
    const tested = this.tested;
    tested.fill(-1, 0, pts.length);

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const x0 = Math.floor(Math.min(a.x, b.x) / GRID_CELL);
      const x1 = Math.floor(Math.max(a.x, b.x) / GRID_CELL);
      const y0 = Math.floor(Math.min(a.y, b.y) / GRID_CELL);
      const y1 = Math.floor(Math.max(a.y, b.y) / GRID_CELL);

      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = cx * 73856093 ^ cy * 19349663;
          let cell = grid.get(key);
          if (!cell) {
            cell = [];
            grid.set(key, cell);
          }
          for (const j of cell) {
            if (i - j < 2 || tested[j] === i) continue;
            tested[j] = i;
            const c = pts[j];
            const d = pts[j + 1];
            const hit = segmentIntersection(c.x, c.y, d.x, d.y, a.x, a.y, b.x, b.y);
            if (!hit) continue;
            const key = c.id < a.id ? c.id * PAIR_KEY + a.id : a.id * PAIR_KEY + c.id;
            const topId = this.layering.get(key) ?? pts[this.chooseTop(j, i)].id;
            layering.set(key, topId);
            const over = topId === a.id ? i : j;
            crossings.push({ first: j, last: i, over, under: over === i ? j : i, x: hit.x, y: hit.y });
          }
          cell.push(i);
        }
      }
    }

    this.layering = layering;
    this.crossings = crossings;
    this.loopCandidates = this.working ? [] : this.findLoopCandidates(crossings);
  }

  chooseTop(j, i) {
    if (!this.isHooked) return i;
    return Math.abs(i - this.hookIndex) <= Math.abs(j - this.hookIndex) ? i : j;
  }

  // Um cruzamento fecha uma volta de fio entre os dois segmentos. Ficam só as voltas mais internas
  // (que não envolvem outra volta já aceita); voltas pequenas demais são ruído.
  findLoopCandidates(crossings) {
    const bySpan = [...crossings].sort((a, b) => a.last - a.first - (b.last - b.first));
    const previous = this.loopCandidates;
    const known = (c) => previous.some((p) => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) < SEGMENT * 2);
    const candidates = [];
    for (const c of bySpan) {
      if (c.last - c.first < 5) continue;
      if (candidates.some((d) => c.first <= d.first && d.last <= c.last)) continue;
      const outline = [{ x: c.x, y: c.y }];
      for (let k = c.first + 1; k <= c.last; k++) outline.push(this.points[k]);
      const area = polygonArea(outline);
      if (area < MIN_LOOP_AREA * (known(c) ? KEEP_LOOP_FACTOR : 1)) continue;
      candidates.push({ ...c, area, outline });
      if (candidates.length >= MAX_LOOP_CANDIDATES) break;
    }
    return candidates;
  }

  // Segmentos do fio atravessados pelo trajeto AB, ignorando a vizinhança do ponto `skipIndex`.
  segmentsCrossedBy(ax, ay, bx, by, skipIndex = -1, skipRadius = 0) {
    const pts = this.points;
    const hits = [];
    for (let i = 0; i < pts.length - 1; i++) {
      if (skipIndex >= 0 && Math.abs(i - skipIndex) <= skipRadius) continue;
      const c = pts[i];
      const d = pts[i + 1];
      const hit = segmentIntersection(ax, ay, bx, by, c.x, c.y, d.x, d.y);
      if (hit) hits.push({ index: i, x: hit.x, y: hit.y });
    }
    return hits;
  }
}
