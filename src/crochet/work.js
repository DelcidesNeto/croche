import { CrochetGraph, EDGE } from './graph.js';

export const KIND = {
  // Laçada formada (fio já puxado através de algo).
  LOOP: 'lacada',
  // Volta de fio passada na agulha e ainda não puxada.
  WRAP: 'volta',
};

export const STATE = {
  ON_HOOK: 'na-agulha',
  CLOSED: 'fechada',
};

export const MAX_ON_HOOK = 8;

/**
 * Estado estrutural da peça: laçadas, conexões, o que está na agulha e o registro de operações.
 * As mudanças acontecem por operações reversíveis `{ label, apply, revert }`, executadas pelo histórico.
 * Posições de laçadas na agulha são atualizadas pela simulação; as das laçadas fechadas são fixas.
 */
export class Work {
  constructor() {
    this.loops = new Map();
    this.graph = new CrochetGraph();
    // Da garganta da agulha em direção ao cabo.
    this.hook = [];
    this.inserted = null;
    this.log = [];
    this.nextId = 1;
    this.version = 0;
  }

  get started() {
    return this.loops.size > 0;
  }

  get front() {
    return this.loops.get(this.hook[0]) ?? null;
  }

  get canPull() {
    return this.front?.kind === KIND.WRAP && this.pullSequence().length > 0;
  }

  get hookIsFull() {
    return this.hook.length >= MAX_ON_HOOK;
  }

  // Ordem em que a volta da garganta atravessa as laçadas ao puxar a agulha para trás.
  pullSequence() {
    const behind = this.hook.slice(1);
    return this.inserted ? [this.inserted, ...behind] : behind;
  }

  *closedLoops() {
    for (const loop of this.loops.values()) {
      if (loop.state === STATE.CLOSED) yield loop;
    }
  }

  touch() {
    this.version++;
  }

  insert(id) {
    const loop = this.loops.get(id);
    if (!loop || loop.state !== STATE.CLOSED) throw new Error(`Não é possível inserir a agulha na laçada ${id}`);
    this.inserted = id;
    this.touch();
  }

  withdraw() {
    if (this.inserted === null) return;
    this.inserted = null;
    this.touch();
  }

  addLoop(loop) {
    this.loops.set(loop.id, loop);
    this.graph.addNode(loop.id);
  }

  removeLoop(id) {
    this.loops.delete(id);
    this.graph.removeNode(id);
  }

  slipKnot({ x, y, angle, look, size }) {
    const id = this.nextId++;
    return {
      label: 'laçada inicial',
      apply: () => {
        this.addLoop({ id, kind: KIND.LOOP, state: STATE.ON_HOOK, x, y, angle, size, ...look });
        this.hook.unshift(id);
        this.log.push({ type: 'inicial', loop: id });
        this.touch();
      },
      revert: () => {
        this.hook.shift();
        this.removeLoop(id);
        this.log.pop();
        this.touch();
      },
    };
  }

  yarnOver({ look, size }) {
    if (!this.started) throw new Error('Faça a laçada inicial antes de laçar o fio');
    const id = this.nextId++;
    const into = this.inserted;
    const front = this.front;
    return {
      label: 'laçar',
      apply: () => {
        this.addLoop({ id, kind: KIND.WRAP, state: STATE.ON_HOOK, x: front.x, y: front.y, angle: front.angle, size, ...look });
        this.hook.unshift(id);
        this.log.push({ type: 'lacar', loop: id, into });
        this.touch();
      },
      revert: () => {
        this.hook.shift();
        this.removeLoop(id);
        this.log.pop();
        this.touch();
      },
    };
  }

  /**
   * Puxa a volta da garganta através das `count` primeiras laçadas de `pullSequence()`.
   * `positions` traz onde cada laçada da agulha fica ao ser fechada: `Map<id, {x, y, angle}>`.
   */
  pullThrough(count, positions) {
    if (!this.canPull) throw new Error('Não há volta na garganta da agulha para puxar');
    const sequence = this.pullSequence().slice(0, count);
    if (sequence.length !== count || count < 1) throw new Error(`Não há ${count} laçadas para atravessar`);

    const frontId = this.hook[0];
    const through = this.inserted !== null && sequence[0] === this.inserted ? this.inserted : null;
    const closing = sequence.filter((id) => id !== through);
    const hookBefore = [...this.hook];
    const insertedBefore = this.inserted;
    const previous = new Map(closing.map((id) => {
      const { x, y, angle } = this.loops.get(id);
      return [id, { x, y, angle }];
    }));
    let edges = [];

    return {
      label: 'puxar',
      apply: () => {
        this.loops.get(frontId).kind = KIND.LOOP;
        edges = [];
        if (through !== null) edges.push(this.graph.connect(frontId, through, EDGE.THROUGH));
        for (const id of closing) {
          const loop = this.loops.get(id);
          loop.state = STATE.CLOSED;
          Object.assign(loop, positions.get(id));
          edges.push(this.graph.connect(frontId, id, EDGE.CLOSES));
        }
        this.hook = [frontId, ...hookBefore.slice(1).filter((id) => !closing.includes(id))];
        if (through !== null) this.inserted = null;
        this.log.push({ type: 'puxar', loop: frontId, through, closed: closing });
        this.touch();
      },
      revert: () => {
        this.loops.get(frontId).kind = KIND.WRAP;
        for (const edge of edges) this.graph.disconnect(edge);
        for (const id of closing) {
          const loop = this.loops.get(id);
          loop.state = STATE.ON_HOOK;
          Object.assign(loop, previous.get(id));
        }
        this.hook = hookBefore;
        this.inserted = insertedBefore;
        this.log.pop();
        this.touch();
      },
    };
  }

  toJSON() {
    return {
      nextId: this.nextId,
      loops: [...this.loops.values()],
      graph: this.graph.toJSON(),
      hook: this.hook,
      inserted: this.inserted,
      log: this.log,
    };
  }

  static fromJSON(data) {
    if (!data || !Array.isArray(data.loops) || !Array.isArray(data.hook) || !Array.isArray(data.log)) {
      throw new Error('Estrutura do trabalho incompleta');
    }
    const work = new Work();
    for (const loop of data.loops) {
      if (typeof loop.id !== 'number' || !Number.isFinite(loop.x) || !Number.isFinite(loop.y)) {
        throw new Error('Laçada com dados inválidos');
      }
      work.loops.set(loop.id, { ...loop });
    }
    work.graph = CrochetGraph.fromJSON(data.graph);
    for (const id of work.loops.keys()) {
      if (!work.graph.nodes.has(id)) throw new Error(`Laçada ${id} sem nó no grafo`);
    }
    for (const id of data.hook) {
      if (work.loops.get(id)?.state !== STATE.ON_HOOK) throw new Error(`Laçada ${id} não está na agulha`);
    }
    if (data.inserted !== null && work.loops.get(data.inserted)?.state !== STATE.CLOSED) {
      throw new Error('A agulha está inserida numa laçada inexistente');
    }
    work.hook = [...data.hook];
    work.inserted = data.inserted;
    work.log = data.log.map((entry) => ({ ...entry }));
    let maxId = 0;
    for (const id of work.loops.keys()) maxId = Math.max(maxId, id);
    work.nextId = Math.max(data.nextId ?? 0, maxId + 1);
    return work;
  }
}
