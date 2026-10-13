import { damp, dist } from '../core/math.js';
import { STATE } from '../crochet/work.js';
import { loopContains, loopRadii } from './loops.js';

// Distância da ponta até a garganta, onde fica a primeira laçada da agulha.
export const SLOT_START = 9;
const RETURN_TO_FINISH = 8;
const IDLE_TO_FINISH = 0.4;
// Abaixo desta velocidade de recuo (unidades/s) a agulha conta como parada; ela segue o mouse amortecida
// e nunca para exatamente.
const IDLE_SPEED = 15;
const INSERT_SLACK = 3;
const WITHDRAW_MARGIN = 14;
// Avanço contínuo da agulha que, no modo tapeçaria, insere a ponta no ponto de baixo.
const PUSH_TO_INSERT = 12;

export function slotSpacing(thickness) {
  return Math.max(7, thickness * 1.05);
}

// Quanto a agulha precisa recuar para a volta da garganta atravessar cada laçada seguinte.
export function pullStep(thickness) {
  return Math.max(14, slotSpacing(thickness) * 1.5);
}

/**
 * Traduz o movimento da agulha em operações sobre o trabalho:
 * - avançar a ponta para dentro de uma laçada fechada insere a agulha nela;
 * - com uma volta de fio na garganta, recuar a agulha (na direção do cabo) passa essa volta
 *   pelas laçadas, uma a uma, conforme a distância percorrida.
 * Também posiciona as laçadas que estão na agulha a cada quadro.
 * No modo tapeçaria (`target` definido), a laçada onde a agulha entra é sempre `target`.
 */
export class Stitching {
  constructor() {
    this.pull = null;
    this.offsets = new Map();
    this.inside = new Set();
    this.ignored = new Set();
    this.hover = null;
    this.push = 0;
  }

  reset() {
    this.pull = null;
    this.push = 0;
  }

  // Laçadas recém-fechadas sob a ponta não contam como "entrar" nelas até a ponta sair.
  ignoreUntilLeft(ids) {
    for (const id of ids) this.ignored.add(id);
  }

  update(dt, work, needle, thickness, target) {
    const events = [];
    if (!work.started) {
      this.pull = null;
      this.hover = null;
      return events;
    }

    const hx = Math.cos(needle.angle);
    const hy = Math.sin(needle.angle);
    const backward = (needle.x - needle.prevX) * hx + (needle.y - needle.prevY) * hy;

    const finished = this.advancePull(dt, work, backward, thickness, events);
    this.layoutHook(dt, work, needle, thickness);
    if (finished) {
      const positions = new Map();
      for (const id of work.pullSequence().slice(0, finished)) {
        const { x, y, angle } = work.loops.get(id);
        positions.set(id, { x, y, angle });
      }
      events.push({ type: 'pull', count: finished, positions });
      this.pull = null;
    }

    if (target === undefined) this.trackInsertion(work, needle, backward, events);
    else this.guideInsertion(work, backward, target, events);
    return events;
  }

  // Devolve quantas laçadas foram atravessadas quando o puxão termina; 0 enquanto continua.
  advancePull(dt, work, backward, thickness, events) {
    if (!work.canPull) {
      this.pull = null;
      return 0;
    }
    const sequence = work.pullSequence();
    const step = pullStep(thickness);
    const pull = (this.pull ??= { distance: 0, max: 0, passed: 0, idle: 0 });

    pull.distance = Math.max(0, pull.distance + backward);
    pull.max = Math.max(pull.max, pull.distance);
    pull.idle = backward > IDLE_SPEED * dt ? 0 : pull.idle + dt;

    const passed = Math.min(sequence.length, Math.floor(pull.max / step));
    for (let j = pull.passed; j < passed; j++) events.push({ type: 'pass', id: sequence[j] });
    pull.passed = passed;

    if (passed === 0) {
      if (pull.distance === 0) pull.max = 0;
      return 0;
    }
    const done = passed === sequence.length || pull.max - pull.distance > RETURN_TO_FINISH || pull.idle > IDLE_TO_FINISH;
    return done ? passed : 0;
  }

  // Durante o puxão, as laçadas atrás da garganta ficam paradas no mundo enquanto a agulha recua.
  layoutHook(dt, work, needle, thickness) {
    const hx = Math.cos(needle.angle);
    const hy = Math.sin(needle.angle);
    const spacing = slotSpacing(thickness);
    const offsets = new Map();

    work.hook.forEach((id, k) => {
      const loop = work.loops.get(id);
      const held = this.pull && k >= 1;
      const offset = held ? this.pull.distance : damp(this.offsets.get(id) ?? 0, 0, 16, dt);
      offsets.set(id, offset);
      const s = Math.max(2, SLOT_START + k * spacing - offset);
      loop.x = needle.x + hx * s;
      loop.y = needle.y + hy * s;
      loop.angle = needle.angle;
    });

    this.offsets = offsets;
  }

  trackInsertion(work, needle, backward, events) {
    const inside = [];
    const ignored = new Set();
    for (const loop of work.closedLoops()) {
      if (!loopContains(loop, needle.x, needle.y, INSERT_SLACK)) continue;
      if (this.ignored.has(loop.id)) ignored.add(loop.id);
      else inside.push(loop);
    }
    this.ignored = ignored;
    this.hover = inside.length ? nearest(inside, needle.x, needle.y) : null;

    if (work.inserted === null) {
      const entered = inside.filter((loop) => !this.inside.has(loop.id));
      if (entered.length && backward < 0) {
        events.push({ type: 'insert', id: nearest(entered, needle.x, needle.y).id });
      }
    } else if (!(this.pull && this.pull.max > 0)) {
      const loop = work.loops.get(work.inserted);
      const { rx, ry } = loopRadii(loop);
      if (loop.state !== STATE.CLOSED || dist(needle.x, needle.y, loop.x, loop.y) > Math.max(rx, ry) + WITHDRAW_MARGIN) {
        events.push({ type: 'withdraw' });
      }
    }

    this.inside = new Set(inside.map((loop) => loop.id));
  }

  // Sem mirar: avançar a agulha por um trecho contínuo insere a ponta no ponto de baixo.
  guideInsertion(work, backward, target, events) {
    const base = work.loops.get(target);
    this.hover = base?.state === STATE.CLOSED ? base : null;
    this.push = backward <= 0 ? this.push - backward : 0;
    if (work.inserted === null && this.hover && this.push > PUSH_TO_INSERT) {
      events.push({ type: 'insert', id: target });
      this.push = 0;
    }
  }

  // Ponto onde o puxão começou e marcos onde cada laçada é atravessada, para a guia visual.
  pullGuide(work, needle, thickness) {
    if (!work.canPull) return null;
    const hx = Math.cos(needle.angle);
    const hy = Math.sin(needle.angle);
    const distance = this.pull?.distance ?? 0;
    const step = pullStep(thickness);
    const ox = needle.x - hx * distance;
    const oy = needle.y - hy * distance;
    const marks = work.pullSequence().map((id, j) => ({
      id,
      x: ox + hx * step * (j + 1),
      y: oy + hy * step * (j + 1),
      passed: j < (this.pull?.passed ?? 0),
    }));
    return { x: ox, y: oy, marks, passed: this.pull?.passed ?? 0 };
  }
}

function nearest(loops, x, y) {
  let best = loops[0];
  let bestD = Infinity;
  for (const loop of loops) {
    const d = dist(x, y, loop.x, loop.y);
    if (d < bestD) {
      bestD = d;
      best = loop;
    }
  }
  return best;
}
