import { STATE } from '../crochet/work.js';

// Tamanho da laçada a partir da espessura do fio: com a linha tensionada, as laçadas saem mais justas.
export function loopSize(thickness, tension) {
  return thickness * (1.45 - 0.55 * tension);
}

// Fio gasto para formar uma laçada (perímetro aproximado da elipse).
export function loopYarnLength(size) {
  return Math.PI * size * 2.2;
}

/**
 * No trabalho, a laçada fica deitada na direção em que foi fechada;
 * na agulha, ela abraça a haste (estreita no sentido da haste).
 */
export function loopRadii(loop) {
  return loop.state === STATE.ON_HOOK
    ? { rx: loop.thickness * 0.7, ry: loop.size * 0.95 }
    : { rx: loop.size * 1.35, ry: loop.size * 0.85 };
}

// Teste geométrico: o ponto está dentro do anel (elipse), com folga `slack` em unidades do mundo.
export function loopContains(loop, px, py, slack = 0) {
  const { rx, ry } = loopRadii(loop);
  const cos = Math.cos(-loop.angle);
  const sin = Math.sin(-loop.angle);
  const dx = px - loop.x;
  const dy = py - loop.y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const ax = rx + slack;
  const ay = ry + slack;
  return (lx * lx) / (ax * ax) + (ly * ly) / (ay * ay) <= 1;
}
