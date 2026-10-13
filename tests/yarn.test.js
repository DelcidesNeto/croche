import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dist } from '../src/core/math.js';
import { SEGMENT, Yarn } from '../src/sim/yarn.js';

const FRAME = 1 / 60;

function makeYarn() {
  return new Yarn({ anchorX: 0, anchorY: 0, towardX: -400, towardY: 0, count: 40 });
}

// Move o gancho em linha reta até (x, y) ao longo de `frames` quadros.
function dragHook(yarn, x, y, frames) {
  const sx = yarn.hookX;
  const sy = yarn.hookY;
  for (let f = 1; f <= frames; f++) {
    const t = f / frames;
    yarn.setHook(sx + (x - sx) * t, sy + (y - sy) * t);
    yarn.update(FRAME);
  }
}

function catchNear(yarn, x, y) {
  const hit = yarn.nearest(x, y, 20);
  assert.ok(hit, 'o fio deveria estar ao alcance');
  yarn.catchAt(hit.index, hit.x, hit.y);
  return hit;
}

test('o fio nasce contínuo, com segmentos do tamanho de repouso', () => {
  const yarn = makeYarn();
  const pts = yarn.points;
  assert.equal(pts.length, 40);
  for (let i = 0; i < pts.length - 1; i++) {
    assert.ok(Math.abs(dist(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) - SEGMENT) < 1e-6);
  }
});

test('nearest só encontra o fio dentro do alcance e nunca devolve o ponto preso ao novelo', () => {
  const yarn = makeYarn();
  assert.equal(yarn.nearest(0, 300, 20), null);
  const hit = yarn.nearest(0, 0, 20);
  assert.ok(hit.index >= 1);
});

test('puxar a linha sem segurar faz o novelo soltar fio sem esticar demais', () => {
  const yarn = makeYarn();
  const before = yarn.points.length;
  const hit = catchNear(yarn, yarn.points[30].x, yarn.points[30].y);
  dragHook(yarn, hit.x, 300, 90);
  for (let i = 0; i < 30; i++) yarn.update(FRAME);

  assert.ok(yarn.isHooked);
  assert.ok(yarn.points.length > before, 'o novelo deveria ter soltado fio');
  assert.ok(yarn.fed > 0);
  assert.ok(yarn.stretch < 1.12, `esticamento ${yarn.stretch}`);

  const anchor = yarn.points[0];
  assert.deepEqual([anchor.x, anchor.y], [0, 0]);
  const hooked = yarn.points[yarn.hookIndex];
  assert.ok(dist(hooked.x, hooked.y, yarn.hookX, yarn.hookY) < 1e-6);
});

test('o novelo solta só o fio necessário, mesmo com um puxão brusco', () => {
  for (const frames of [10, 60]) {
    const yarn = makeYarn();
    const hit = catchNear(yarn, yarn.points[36].x, yarn.points[36].y);
    dragHook(yarn, hit.x - 300, hit.y + 260, frames);
    for (let i = 0; i < 30; i++) yarn.update(FRAME);

    const straight = Math.hypot(yarn.hookX, yarn.hookY);
    const rest = yarn.restLength();
    assert.ok(rest >= straight * 0.99 && rest <= straight * 1.05, `fio ${rest.toFixed(0)} para distância ${straight.toFixed(0)}`);
  }
});

test('segurando a linha o novelo não solta fio e a linha escapa quando a tensão passa do limite', () => {
  const yarn = makeYarn();
  const before = yarn.points.length;
  const hit = catchNear(yarn, yarn.points[20].x, yarn.points[20].y);
  yarn.holding = true;
  dragHook(yarn, hit.x, 400, 60);

  assert.equal(yarn.points.length, before);
  assert.equal(yarn.isHooked, false);
  const events = yarn.drainEvents();
  assert.equal(events[0]?.type, 'slip');
});

// Leva a ponta do fio para cima e depois por cima do trecho ainda deitado na mesa.
function formLoop(yarn) {
  const target = { x: yarn.points[15].x, y: yarn.points[15].y };
  const hit = catchNear(yarn, yarn.points[36].x, yarn.points[36].y);
  dragHook(yarn, hit.x, hit.y - 70, 40);
  dragHook(yarn, target.x, hit.y - 70, 40);
  dragHook(yarn, target.x, target.y + 50, 40);
  return yarn.loopCandidates[0];
}

test('dar uma volta com a linha presa forma um cruzamento e uma laçada possível', () => {
  const yarn = makeYarn();
  formLoop(yarn);

  assert.ok(yarn.crossings.length > 0, 'o fio deveria cruzar consigo mesmo');
  assert.ok(yarn.loopCandidates.length > 0, 'deveria existir uma volta fechada');
  const crossing = yarn.crossings[0];
  const near = (i) => Math.abs(i - yarn.hookIndex);
  assert.ok(near(crossing.over) <= near(crossing.under), 'o trecho levado pela agulha passa por cima');
});

test('soltar a linha devolve o fio à simulação livre', () => {
  const yarn = makeYarn();
  catchNear(yarn, yarn.points[10].x, yarn.points[10].y);
  yarn.release();
  assert.equal(yarn.isHooked, false);
  assert.equal(yarn.tension, 0);
  yarn.update(FRAME);
});

test('o caminho da agulha detecta quando atravessa outro trecho do fio', () => {
  const yarn = makeYarn();
  const a = yarn.points[15];
  const b = yarn.points[16];
  const p = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const hits = yarn.segmentsCrossedBy(p.x, p.y - 30, p.x, p.y + 30);
  assert.equal(hits.length, 1);
  assert.equal(yarn.segmentsCrossedBy(p.x, p.y - 30, p.x, p.y + 30, 15, 3).length, 0);
});

test('apertar a volta tira do fio o trecho da laçada e a ponta solta; restaurar devolve tudo', () => {
  const yarn = makeYarn();
  const candidate = formLoop(yarn);
  const count = yarn.points.length;
  const hookIndex = yarn.hookIndex;
  const { before } = yarn.tieKnot(candidate);

  assert.ok(yarn.working);
  assert.equal(yarn.hookIndex, yarn.points.length - 1, 'o fio termina na agulha');
  const kept = [...Array(hookIndex + 1).keys()].filter((i) => i === hookIndex || i <= candidate.first || i > candidate.last);
  assert.equal(yarn.points.length, kept.length);
  for (let i = 0; i < 30; i++) yarn.update(FRAME);
  assert.equal(yarn.loopCandidates.length, 0, 'preso ao trabalho, o fio não oferece outra laçada inicial');

  yarn.restore(before);
  assert.equal(yarn.points.length, count);
  assert.equal(yarn.hookIndex, hookIndex);
  assert.equal(yarn.working, false);
});

test('com a linha solta, enfiar a agulha na volta pega o fio do lado do novelo', () => {
  const yarn = makeYarn();
  formLoop(yarn);
  yarn.release();
  for (let i = 0; i < 60; i++) yarn.update(FRAME);
  const candidate = yarn.loopCandidates[0];
  assert.ok(candidate, 'a volta continua deitada na mesa depois de soltar a linha');

  yarn.tieKnot(candidate, 5, 5);
  assert.ok(yarn.working && yarn.isHooked);
  assert.equal(yarn.points.length, candidate.first + 1);
  assert.equal(yarn.hookIndex, candidate.first);
  for (let i = 0; i < 20; i++) yarn.update(FRAME);
  const hook = yarn.points[yarn.hookIndex];
  assert.ok(dist(hook.x, hook.y, 5, 5) < 1e-6, 'o fio vai até a garganta da agulha');
});

test('preso ao trabalho, o fio não escapa ao segurar e cada laçada consome fio', () => {
  const yarn = makeYarn();
  yarn.tieKnot(formLoop(yarn));
  yarn.holding = true;
  dragHook(yarn, yarn.hookX, yarn.hookY + 400, 60);
  assert.ok(yarn.isHooked);
  assert.equal(yarn.drainEvents().some((e) => e.type === 'slip'), false);

  yarn.holding = false;
  for (let i = 0; i < 30; i++) yarn.update(FRAME);
  const rest = yarn.restLength();
  yarn.consume(40);
  assert.ok(Math.abs(yarn.restLength() - (rest - 40)) < 1e-6);
  const fed = yarn.fed;
  for (let i = 0; i < 30; i++) yarn.update(FRAME);
  assert.ok(yarn.fed > fed, 'o novelo repõe o fio consumido');
});

test('o estado do fio é salvo e reconstruído; dados inválidos são recusados', () => {
  const yarn = makeYarn();
  catchNear(yarn, yarn.points[30].x, yarn.points[30].y);
  dragHook(yarn, 50, 120, 20);
  const snapshot = JSON.parse(JSON.stringify(yarn.snapshot()));
  const copy = Yarn.fromSnapshot(snapshot);
  assert.deepEqual(copy.snapshot(), snapshot);
  assert.ok(copy.isHooked);
  assert.throws(() => Yarn.fromSnapshot({ ...snapshot, points: [[0, 0]] }));
  assert.throws(() => Yarn.fromSnapshot({ ...snapshot, points: [[0, 0], [Number.NaN, 1]] }));
});
