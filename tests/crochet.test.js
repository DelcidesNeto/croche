import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrochetGraph, EDGE } from '../src/crochet/graph.js';
import { History } from '../src/crochet/history.js';
import { STITCH, recognizeStitches, summarize } from '../src/crochet/recognition.js';
import { KIND, STATE, Work } from '../src/crochet/work.js';
import { loopContains, loopSize, loopYarnLength } from '../src/sim/loops.js';

const look = { color: '#d9a21b', thickness: 8, materialId: 'algodao' };

function setup() {
  const work = new Work();
  const history = new History();
  const knot = () => history.run(work.slipKnot({ x: 0, y: 0, angle: 0, look, size: 9 }));
  const yo = () => history.run(work.yarnOver({ look, size: 9 }));
  const pull = (count) => {
    const positions = new Map(work.pullSequence().map((id) => [id, { x: id * 10, y: 5, angle: 0.5 }]));
    history.run(work.pullThrough(count, positions));
  };
  const insert = (id) => work.insert(id);
  return { work, history, knot, yo, pull, insert };
}

const kinds = (work) => recognizeStitches(work.log).map((s) => s.kind);

test('laçar e puxar por uma laçada forma correntinhas', () => {
  const { work, knot, yo, pull } = setup();
  knot();
  yo();
  pull(1);
  yo();
  pull(1);
  assert.deepEqual(kinds(work), [STITCH.SLIP_KNOT, STITCH.CHAIN, STITCH.CHAIN]);
  assert.equal(work.hook.length, 1);
  assert.equal([...work.closedLoops()].length, 2);
  const [knotId] = work.loops.keys();
  assert.equal(work.graph.edgesTo(knotId, EDGE.CLOSES).length, 1);
});

test('pontos trabalhados numa laçada do trabalho são reconhecidos pelas operações', () => {
  const { work, knot, yo, pull, insert } = setup();
  knot();
  for (let i = 0; i < 4; i++) {
    yo();
    pull(1);
  }
  const base = [...work.closedLoops()].map((l) => l.id);

  insert(base[3]);
  yo();
  pull(1);
  yo();
  pull(2);

  yo();
  insert(base[2]);
  yo();
  pull(1);
  yo();
  pull(2);
  yo();
  pull(2);

  insert(base[1]);
  yo();
  pull(2);

  const stitches = recognizeStitches(work.log);
  assert.deepEqual(stitches.slice(-3).map((s) => s.kind), [STITCH.SINGLE, STITCH.DOUBLE, STITCH.SLIP]);
  assert.deepEqual(stitches.at(-2).bases, [base[2]]);
  assert.equal(work.inserted, null);

  const top = work.loops.get(stitches.at(-3).top);
  assert.equal(work.graph.edgesFrom(stitches.at(-3).loops[0], EDGE.THROUGH)[0].to, base[3]);
  assert.equal(top.kind, KIND.LOOP);
});

test('duas laçadas puxadas na mesma base contam como aumento; duas bases juntas formam diminuição', () => {
  const { work, knot, yo, pull, insert } = setup();
  knot();
  for (let i = 0; i < 3; i++) {
    yo();
    pull(1);
  }
  const base = [...work.closedLoops()].map((l) => l.id);
  for (let i = 0; i < 2; i++) {
    insert(base[2]);
    yo();
    pull(1);
    yo();
    pull(2);
  }
  insert(base[1]);
  yo();
  pull(1);
  insert(base[0]);
  yo();
  pull(1);
  yo();
  pull(3);

  const stitches = recognizeStitches(work.log);
  assert.equal(stitches.at(-1).kind, STITCH.SINGLE_DECREASE);
  assert.equal(summarize(stitches).increases, 1);
});

test('sequências sem padrão seguro ficam como criação livre e o ponto aberto fica em andamento', () => {
  const { work, knot, yo, pull } = setup();
  knot();
  yo();
  yo();
  pull(2);
  yo();
  assert.deepEqual(kinds(work), [STITCH.SLIP_KNOT, STITCH.FREE, STITCH.IN_PROGRESS]);
});

test('desfazer tudo volta ao início e refazer reconstrói exatamente a mesma estrutura', () => {
  const { work, history, knot, yo, pull, insert } = setup();
  knot();
  yo();
  pull(1);
  yo();
  pull(1);
  insert([...work.closedLoops()][0].id);
  yo();
  pull(1);
  yo();
  pull(2);
  const done = JSON.stringify(work.toJSON());

  while (history.canUndo) history.undo();
  assert.equal(work.loops.size, 0);
  assert.equal(work.graph.edges.length, 0);
  assert.deepEqual(work.hook, []);
  assert.deepEqual(work.log, []);

  while (history.canRedo) history.redo();
  assert.equal(JSON.stringify(work.toJSON()), done);
});

test('desfazer um puxão devolve as laçadas à agulha e a agulha à laçada onde estava inserida', () => {
  const { work, history, knot, yo, pull, insert } = setup();
  knot();
  yo();
  pull(1);
  const base = [...work.closedLoops()][0];
  insert(base.id);
  yo();
  pull(1);
  history.undo();
  assert.equal(work.inserted, base.id);
  assert.equal(work.front.kind, KIND.WRAP);
  assert.equal(work.graph.edgesTo(base.id, EDGE.THROUGH).length, 0);
});

test('o trabalho salvo é reconstruído e dados inválidos são recusados', () => {
  const { work, knot, yo, pull } = setup();
  knot();
  yo();
  pull(1);
  const data = JSON.parse(JSON.stringify(work.toJSON()));
  const copy = Work.fromJSON(data);
  assert.deepEqual(JSON.parse(JSON.stringify(copy.toJSON())), data);
  assert.ok(copy.nextId > Math.max(...copy.loops.keys()));

  const broken = structuredClone(data);
  broken.hook = [broken.loops.find((l) => l.state === STATE.CLOSED).id];
  assert.throws(() => Work.fromJSON(broken));
  assert.throws(() => Work.fromJSON({ loops: 'x' }));
});

test('não é possível inserir a agulha numa laçada que está na agulha', () => {
  const { work, knot } = setup();
  knot();
  assert.throws(() => work.insert(work.hook[0]));
});

test('o grafo é reconstruído a partir do formato salvo', () => {
  const graph = new CrochetGraph();
  graph.addNode(1);
  graph.addNode(2);
  graph.connect(2, 1, EDGE.CLOSES);
  const copy = CrochetGraph.fromJSON(JSON.parse(JSON.stringify(graph)));
  assert.deepEqual(copy.toJSON(), graph.toJSON());
  assert.throws(() => copy.connect(1, 99, EDGE.CLOSES));
});

test('a ponta só entra na laçada quando está dentro do anel', () => {
  const loop = { state: STATE.CLOSED, x: 0, y: 0, angle: Math.PI / 2, size: 10, thickness: 8 };
  assert.equal(loopContains(loop, 0, 12), true);
  assert.equal(loopContains(loop, 12, 0), false);
  assert.equal(loopContains(loop, 0, 16), false);
  assert.equal(loopContains(loop, 0, 16, 3), true);
});

test('com a linha tensionada as laçadas saem menores e gastam menos fio', () => {
  assert.ok(loopSize(8, 1) < loopSize(8, 0));
  assert.ok(loopYarnLength(loopSize(8, 1)) < loopYarnLength(loopSize(8, 0)));
});
