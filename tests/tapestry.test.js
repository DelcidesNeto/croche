import assert from 'node:assert/strict';
import { test } from 'node:test';
import { History } from '../src/crochet/history.js';
import { STITCH, recognizeStitches, summarize } from '../src/crochet/recognition.js';
import { cellAt, cellCenter, clampColumns, planTapestry, restingPlace, tapestryGrid } from '../src/crochet/tapestry.js';
import { STATE, Work } from '../src/crochet/work.js';
import { parseProject, serializeProject } from '../src/persist/project.js';
import { Stitching } from '../src/sim/stitching.js';
import { Yarn } from '../src/sim/yarn.js';

const COLUMNS = 4;
const THICKNESS = 8;
const look = { color: '#d9a21b', thickness: THICKNESS, materialId: 'algodao' };
const red = { ...look, color: '#b3263a' };
const grid = tapestryGrid(COLUMNS, THICKNESS);

// Faz os pontos com as operações do trabalho e assenta as laçadas na grade como o App faz.
function tapestry() {
  const work = new Work();
  const history = new History();
  const plan = () => planTapestry(recognizeStitches(work.log), COLUMNS);
  const pull = (count) => {
    const places = plan().places;
    const positions = new Map(work.pullSequence().slice(0, count).map((id) => [id, restingPlace(grid, places.get(id), id)]));
    history.run(work.pullThrough(count, positions));
  };
  const chain = (style = look) => {
    history.run(work.yarnOver({ look: style, size: 11 }));
    pull(1);
  };
  const single = (style = look) => {
    work.insert(plan().base);
    history.run(work.yarnOver({ look: style, size: 11 }));
    pull(1);
    history.run(work.yarnOver({ look: style, size: 11 }));
    pull(2);
  };
  history.run(work.slipKnot({ x: 0, y: 0, angle: 0, look, size: 11 }));
  return { work, history, plan, chain, single };
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('as casas seguem carreiras de ida e volta', () => {
  assert.deepEqual([0, 3, 4, 7, 8].map((k) => cellAt(k, COLUMNS)), [
    { col: 0, row: 0 }, { col: 3, row: 0 }, { col: 3, row: 1 }, { col: 0, row: 1 }, { col: 0, row: 2 },
  ]);
  assert.equal(clampColumns('2'), 4);
  assert.equal(clampColumns(99), 60);
  assert.equal(clampColumns('abc'), 20);
});

test('as correntinhas formam a carreira de base, lado a lado na mesma altura', () => {
  const t = tapestry();
  for (let i = 0; i < COLUMNS; i++) t.chain();
  t.chain();
  const closed = [...t.work.closedLoops()];
  // A laçada inicial fica à esquerda; as correntinhas, uma em cada casa da carreira de base.
  const knot = closed.shift();
  assert.ok(near(knot.x, cellCenter(grid, -1, 0).x));
  closed.slice(0, COLUMNS).forEach((loop, col) => {
    const center = cellCenter(grid, col, 0);
    assert.ok(near(loop.x, center.x) && near(loop.y, center.y), `correntinha ${col} fora da casa`);
    assert.equal(loop.angle, 0);
  });
  // A correntinha a mais, depois da carreira cheia, é a de virar: não ocupa casa.
  const plan = t.plan();
  assert.deepEqual(plan.next, { col: COLUMNS - 1, row: 1 });
  assert.equal(plan.filled, COLUMNS);
});

test('sem a correntinha de virar, o ponto de baixo ainda está na agulha', () => {
  const t = tapestry();
  for (let i = 0; i < COLUMNS; i++) t.chain();
  const plan = t.plan();
  assert.equal(t.work.loops.get(plan.base).state, STATE.ON_HOOK);
  t.chain();
  assert.equal(t.work.loops.get(t.plan().base).state, STATE.CLOSED);
});

test('cada ponto baixo ocupa a casa sobre o ponto da mesma coluna, com a cor do fio usado', () => {
  const t = tapestry();
  for (let i = 0; i < COLUMNS; i++) t.chain();
  t.chain();
  const bases = [];
  for (let i = 0; i < COLUMNS; i++) {
    bases.push(t.plan().base);
    t.single(i % 2 ? red : look);
  }
  t.chain();

  const stitches = recognizeStitches(t.work.log);
  const singles = stitches.filter((s) => s.kind === STITCH.SINGLE);
  assert.equal(singles.length, COLUMNS);
  assert.equal(summarize(singles).increases, 0, 'nenhum ponto repetiu a base');
  // A correntinha de virar ficou na borda, de pé, fora da grade.
  const turn = t.work.loops.get(stitches[1 + COLUMNS].top);
  assert.ok(near(turn.x, cellCenter(grid, COLUMNS, 0.5).x) && near(turn.angle, Math.PI / 2));

  singles.forEach((stitch, i) => {
    const col = COLUMNS - 1 - i;
    assert.deepEqual(stitch.bases, [bases[i]]);
    assert.ok(near(t.work.loops.get(bases[i]).x, cellCenter(grid, col, 0).x), 'a base é a correntinha da mesma coluna');
    const center = cellCenter(grid, col, 1);
    const [body, top] = stitch.loops.map((id) => t.work.loops.get(id));
    assert.equal(body.state, STATE.CLOSED);
    assert.equal(top.state, STATE.CLOSED);
    assert.ok(near(body.y, center.y) && near(top.y, center.y));
    assert.ok(body.x < center.x && top.x > center.x, 'as duas laçadas formam o V dentro da casa');
    assert.equal(top.color, i % 2 ? red.color : look.color);
  });
  assert.deepEqual(t.plan().next, { col: 0, row: 2 });
});

test('desfazer devolve as laçadas para a agulha e a próxima casa volta a ser a mesma', () => {
  const t = tapestry();
  for (let i = 0; i < COLUMNS; i++) t.chain();
  t.chain();
  const structure = () => {
    const { loops, graph, hook, log } = t.work.toJSON();
    return JSON.stringify({ loops, graph, hook, log });
  };
  const before = structure();
  const { next, base } = t.plan();
  t.single();
  assert.notDeepEqual(t.plan().next, next);
  for (let i = 0; i < 4; i++) t.history.undo();
  assert.equal(structure(), before);
  assert.deepEqual(t.plan().next, next);
  // Como no modo livre, desfazer o primeiro puxão deixa a agulha ainda dentro do ponto de baixo.
  assert.equal(t.work.inserted, base);
});

test('no modo tapeçaria, avançar a agulha insere a ponta no ponto de baixo, sem mirar', () => {
  const t = tapestry();
  for (let i = 0; i < COLUMNS; i++) t.chain();
  t.chain();
  const stitching = new Stitching();
  const needle = { x: 500, y: 500, prevX: 500, prevY: 500, angle: 0 };
  const target = t.plan().base;
  const step = (dx) => {
    needle.prevX = needle.x;
    needle.x += dx;
    return stitching.update(1 / 60, t.work, needle, THICKNESS, target);
  };

  // Recuar (na direção do cabo) não insere; o ponto de baixo fica destacado.
  let events = [];
  for (let i = 0; i < 10; i++) events.push(...step(3));
  assert.equal(events.length, 0);
  assert.equal(stitching.hover.id, target);

  events = [];
  for (let i = 0; i < 10; i++) events.push(...step(-2));
  assert.deepEqual(events, [{ type: 'insert', id: target }]);
});

test('a tapeçaria salva volta com a mesma largura; larguras inválidas são recusadas', () => {
  const t = tapestry();
  t.chain();
  const yarn = new Yarn({ anchorX: 0, anchorY: 0, towardX: -100, towardY: 0, count: 20 });
  yarn.catchAt(19, 10, 10);
  yarn.tieAtHook();
  assert.equal(yarn.points.length, 20);
  assert.ok(yarn.working);

  const data = JSON.parse(JSON.stringify(serializeProject({
    project: { id: 'p2', name: 'Coração', createdAt: 1 },
    workTime: 3,
    tapestry: { columns: COLUMNS },
    style: { colorId: 'cereja', thicknessId: 'medio', materialId: 'algodao' },
    novelos: [],
    work: t.work,
    yarn,
    needle: { x: 0, y: 0, baseAngle: 0 },
    viewport: { x: 0, y: 0, targetZoom: 1 },
  })));
  assert.deepEqual(parseProject(data).tapestry, { columns: COLUMNS });
  assert.equal(parseProject({ ...data, tapestry: undefined }).tapestry, null);
  assert.throws(() => parseProject({ ...data, tapestry: { columns: 2 } }), /largura/);
});
