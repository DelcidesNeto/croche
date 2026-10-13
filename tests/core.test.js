import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Viewport } from '../src/camera/viewport.js';
import { closestPointOnSegment, polygonArea, segmentIntersection } from '../src/core/math.js';
import { YARN_COLORS, colorFamily, resolveStyle } from '../src/sim/materials.js';
import { Needle } from '../src/sim/needle.js';

test('cada cor tem três tons mais claros e três mais escuros, com a própria cor no meio', () => {
  const luminance = (hex) => [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);
  for (const family of YARN_COLORS) {
    assert.equal(family.tones.length, 7);
    assert.equal(family.tones[3].id, family.id);
    const values = family.tones.map((tone) => luminance(tone.value));
    for (let i = 1; i < values.length; i++) assert.ok(values[i] < values[i - 1], `${family.name}: tons fora de ordem`);
  }
});

test('tons são escolhidos pelo id e cores salvas antes dos tons continuam iguais', () => {
  const dark = resolveStyle({ colorId: 'cereja-escuro-2' });
  assert.equal(dark.colorName, 'Cereja (tom escuro 2)');
  assert.equal(colorFamily(dark.colorId).id, 'cereja');
  assert.equal(resolveStyle({ colorId: 'cereja' }).color, '#b3263a');
  assert.equal(resolveStyle({ colorId: 'nao-existe' }).colorId, 'mostarda');
});

test('interseção de segmentos é estrita', () => {
  assert.ok(segmentIntersection(0, 0, 10, 10, 0, 10, 10, 0));
  assert.equal(segmentIntersection(0, 0, 10, 0, 0, 5, 10, 5), null);
  assert.equal(segmentIntersection(0, 0, 10, 0, 10, 0, 20, 5), null);
});

test('ponto mais próximo do segmento e área de polígono', () => {
  const c = closestPointOnSegment(5, 5, 0, 0, 10, 0);
  assert.deepEqual([c.x, c.y, c.d2], [5, 0, 25]);
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), 100);
});

test('câmera converte tela e mundo nos dois sentidos', () => {
  const v = new Viewport();
  v.resize(800, 600, 2);
  v.x = 100;
  v.y = -50;
  v.zoom = v.targetZoom = 2;
  const w = v.toWorld(200, 450);
  const s = v.toScreen(w.x, w.y);
  assert.ok(Math.abs(s.x - 200) < 1e-9 && Math.abs(s.y - 450) < 1e-9);
});

test('o zoom mantém fixo o ponto sob o cursor', () => {
  const v = new Viewport();
  v.resize(800, 600, 1);
  const before = v.toWorld(650, 120);
  v.zoomAt(650, 120, 2);
  for (let i = 0; i < 120; i++) v.update(1 / 60);
  assert.equal(v.zoom, 2);
  const after = v.toWorld(650, 120);
  assert.ok(Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.y - before.y) < 1e-6);
});

test('a agulha se aproxima do alvo com suavidade, sem teleportar', () => {
  const needle = new Needle(0, 0);
  needle.setTarget(100, 0);
  needle.update(1 / 60);
  assert.ok(needle.x > 0 && needle.x < 100);
  for (let i = 0; i < 120; i++) needle.update(1 / 60);
  assert.ok(Math.abs(needle.x - 100) < 0.5);
});

test('girar a agulha muda a orientação de forma gradual', () => {
  const needle = new Needle(0, 0);
  const start = needle.angle;
  needle.rotate(1);
  needle.update(1 / 60);
  assert.ok(needle.angle > start && needle.angle < start + 1);
  for (let i = 0; i < 120; i++) needle.update(1 / 60);
  assert.ok(Math.abs(needle.angle - (start + 1)) < 0.01);
});
