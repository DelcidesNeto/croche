import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EDGE } from '../src/crochet/graph.js';
import { History } from '../src/crochet/history.js';
import { STITCH, recognizeStitches } from '../src/crochet/recognition.js';
import { STATE, Work } from '../src/crochet/work.js';
import { parseProject, serializeProject } from '../src/persist/project.js';
import { SLOT_START, Stitching, pullStep, slotSpacing } from '../src/sim/stitching.js';
import { Yarn } from '../src/sim/yarn.js';

const FRAME = 1 / 60;
const THICKNESS = 8;
const look = { color: '#d9a21b', thickness: THICKNESS, materialId: 'algodao' };

// Conduz a agulha quadro a quadro e aplica os eventos do mesmo jeito que o App.
function bench() {
  const work = new Work();
  const history = new History();
  const stitching = new Stitching();
  const needle = { x: 0, y: 0, prevX: 0, prevY: 0, angle: 0 };
  const events = [];

  const frame = () => {
    for (const event of stitching.update(FRAME, work, needle, THICKNESS)) {
      events.push(event);
      if (event.type === 'insert') work.insert(event.id);
      else if (event.type === 'withdraw') work.withdraw();
      else if (event.type === 'pull') {
        history.run(work.pullThrough(event.count, event.positions));
        stitching.ignoreUntilLeft(work.log.at(-1).closed);
      }
    }
  };
  const move = (dx, dy, frames = 10) => {
    for (let f = 0; f < frames; f++) {
      needle.prevX = needle.x;
      needle.prevY = needle.y;
      needle.x += dx / frames;
      needle.y += dy / frames;
      frame();
    }
  };
  const place = (x, y, angle = needle.angle) => {
    Object.assign(needle, { x, y, prevX: x, prevY: y, angle });
    frame();
  };
  const wait = (seconds) => {
    for (let t = 0; t < seconds; t += FRAME) place(needle.x, needle.y);
  };
  const knot = () => history.run(work.slipKnot({ x: needle.x, y: needle.y, angle: needle.angle, look, size: 9 }));
  const yo = () => history.run(work.yarnOver({ look, size: 9 }));
  // Recuar a agulha ao longo do cabo (ângulo atual).
  const pullBack = (distance) => move(Math.cos(needle.angle) * distance, Math.sin(needle.angle) * distance);

  return { work, history, stitching, needle, events, move, place, wait, knot, yo, pullBack };
}

function chain(b, n) {
  for (let i = 0; i < n; i++) {
    b.yo();
    b.pullBack(pullStep(THICKNESS) + 4);
  }
}

test('as laçadas na agulha ficam em fila a partir da garganta e acompanham a agulha', () => {
  const b = bench();
  b.knot();
  b.yo();
  b.place(100, 50, Math.PI / 2);
  const [front, back] = b.work.hook.map((id) => b.work.loops.get(id));
  assert.ok(Math.abs(front.x - 100) < 1e-9 && Math.abs(front.y - (50 + SLOT_START)) < 1e-9);
  assert.ok(Math.abs(back.y - (50 + SLOT_START + slotSpacing(THICKNESS))) < 1e-9);
  assert.equal(back.angle, Math.PI / 2);
});

test('recuar a agulha com uma volta na garganta puxa o fio pela laçada e forma correntinhas', () => {
  const b = bench();
  b.knot();
  chain(b, 3);
  assert.deepEqual(recognizeStitches(b.work.log).map((s) => s.kind), [STITCH.SLIP_KNOT, STITCH.CHAIN, STITCH.CHAIN, STITCH.CHAIN]);
  const closed = [...b.work.closedLoops()];
  assert.equal(closed.length, 3);
  // Cada laçada fica onde estava ao ser atravessada, uma depois da outra ao longo do recuo.
  for (let i = 1; i < closed.length; i++) assert.ok(closed[i].x > closed[i - 1].x);
  assert.ok(b.events.some((e) => e.type === 'pass'));
});

test('recuar pouco não puxa nada; parar no meio conclui o puxão pelas laçadas já atravessadas', () => {
  const b = bench();
  b.knot();
  b.yo();
  b.pullBack(pullStep(THICKNESS) * 0.5);
  b.wait(1);
  assert.equal(b.work.log.length, 2, 'meio recuo não atravessa a laçada');
  b.pullBack(pullStep(THICKNESS) * 0.4);
  b.move(-20, 0);
  assert.equal(b.work.log.at(-1).type, 'lacar', 'voltar sem atravessar só cancela o gesto');

  b.yo();
  b.yo();
  b.pullBack(pullStep(THICKNESS) + 2);
  b.wait(0.6);
  const pull = b.work.log.at(-1);
  assert.equal(pull.type, 'puxar');
  assert.equal(pull.closed.length, 1, 'puxou só pela primeira laçada atrás da garganta');
  assert.equal(b.work.hook.length, 3);
});

test('o puxão termina mesmo com a agulha ainda se acomodando atrás do mouse', () => {
  const b = bench();
  b.knot();
  b.yo();
  b.yo();
  // Aproximação amortecida, como a agulha seguindo o mouse: nunca para exatamente.
  let remaining = pullStep(THICKNESS) + 6;
  for (let f = 0; f < 60; f++) {
    const step = remaining * 0.28;
    remaining -= step;
    b.move(step, 0, 1);
  }
  const pull = b.work.log.at(-1);
  assert.equal(pull.type, 'puxar');
  assert.equal(pull.closed.length, 1);
});

test('avançar a ponta numa laçada da peça insere a agulha; ponto baixo é reconhecido pelos gestos', () => {
  const b = bench();
  b.knot();
  chain(b, 4);
  const base = [...b.work.closedLoops()][1];

  // Agulha de pé (cabo para cima): avançar é descer em y.
  b.place(base.x, base.y - 30, -Math.PI / 2);
  b.move(0, 30);
  assert.equal(b.work.inserted, base.id);

  b.yo();
  b.pullBack(pullStep(THICKNESS) + 2);
  b.wait(0.6);
  assert.equal(b.work.inserted, null);
  assert.equal(b.work.hook.length, 2);

  b.yo();
  b.pullBack(pullStep(THICKNESS) * 2 + 4);
  const stitches = recognizeStitches(b.work.log);
  assert.equal(stitches.at(-1).kind, STITCH.SINGLE);
  assert.deepEqual(stitches.at(-1).bases, [base.id]);
  assert.equal(b.work.graph.edgesTo(base.id, EDGE.THROUGH).length, 1);
  assert.equal(b.work.hook.length, 1);
});

test('a agulha sai da laçada ao se afastar dela sem puxar, e laçadas recém-fechadas não prendem a ponta', () => {
  const b = bench();
  b.knot();
  chain(b, 2);
  assert.equal(b.work.inserted, null, 'a correntinha recém-fechada sob a ponta não insere a agulha');

  const base = [...b.work.closedLoops()][0];
  b.place(base.x, base.y - 30, -Math.PI / 2);
  b.move(0, 30);
  assert.equal(b.work.inserted, base.id);
  b.move(0, -60);
  assert.equal(b.work.inserted, null);
  assert.ok(b.events.some((e) => e.type === 'withdraw'));
});

test('desfazer um puxão feito por gestos devolve a estrutura anterior', () => {
  const b = bench();
  b.knot();
  chain(b, 2);
  const before = JSON.stringify(b.work.toJSON().graph);
  b.yo();
  b.pullBack(pullStep(THICKNESS) + 4);
  b.history.undo();
  b.history.undo();
  assert.equal(JSON.stringify(b.work.toJSON().graph), before);
  assert.equal(b.work.hook.length, 1);
  assert.equal([...b.work.closedLoops()].length, 2);
});

test('o projeto salvo volta igual: trabalho, fio, novelos, agulha e câmera', () => {
  const b = bench();
  b.knot();
  chain(b, 3);
  const yarn = new Yarn({ anchorX: 0, anchorY: 0, towardX: -100, towardY: 0, count: 20 });
  yarn.catchAt(19, 10, 10);
  yarn.working = true;

  const data = JSON.parse(JSON.stringify(serializeProject({
    project: { id: 'p1', name: 'Tapete', createdAt: 1 },
    workTime: 42,
    style: { colorId: 'anil', thicknessId: 'grosso', materialId: 'la' },
    novelos: [{ colorId: 'anil', thicknessId: 'grosso', materialId: 'la' }],
    work: b.work,
    yarn,
    needle: { x: 5, y: 6, baseAngle: 1 },
    viewport: { x: 7, y: 8, targetZoom: 1.5 },
  })));
  const loaded = parseProject(data);

  assert.equal(loaded.project.name, 'Tapete');
  assert.equal(loaded.workTime, 42);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.work.toJSON())), data.work);
  assert.deepEqual(loaded.yarn.snapshot(), data.yarn);
  assert.deepEqual(loaded.needle, { x: 5, y: 6, angle: 1 });
  assert.deepEqual(loaded.camera, { x: 7, y: 8, zoom: 1.5 });
  assert.equal(loaded.novelos[0].colorId, 'anil');
  assert.equal([...loaded.work.loops.values()].filter((l) => l.state === STATE.CLOSED).length, 3);

  assert.throws(() => parseProject({ ...data, yarn: { ...data.yarn, working: false } }), /não corresponde/);
  assert.throws(() => parseProject({ ...data, version: 99 }), /versão mais nova/);
  assert.throws(() => parseProject(null));
});
