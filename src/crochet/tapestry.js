import { STITCH } from './recognition.js';

export const COLUMNS = { min: 4, max: 500, standard: 20 };

// A carreira de base fica nesta altura do mundo e as outras sobem a partir dela.
const BASE_Y = 60;
const CENTER_X = -40;
// Inclinação dos dois braços do V que cada ponto forma na casa.
const ARM_ANGLE = 1.05;

export function clampColumns(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(COLUMNS.max, Math.max(COLUMNS.min, n)) : COLUMNS.standard;
}

// Medidas da grade a partir da espessura do fio da laçada inicial.
export function tapestryGrid(columns, thickness) {
  const width = thickness * 3.2;
  const height = thickness * 2.7;
  return { columns, width, height, x0: CENTER_X - ((columns - 1) * width) / 2, y0: BASE_Y };
}

export function cellCenter(grid, col, row) {
  return { x: grid.x0 + col * grid.width, y: grid.y0 - row * grid.height };
}

// Casa k da grade, em carreiras de ida e volta; a de base vai da esquerda para a direita.
export function cellAt(k, columns) {
  const row = Math.floor(k / columns);
  const i = k % columns;
  return { col: row % 2 === 0 ? i : columns - 1 - i, row };
}

function placeStitch(stitch, cell, last) {
  if (stitch.kind === STITCH.SLIP_KNOT) return { col: -1, row: 0, inGrid: false };
  if (cell.row === 0 || stitch.bases.length) return { ...cell, inGrid: true };
  // Correntinha fora da carreira de base (a de virar): fica na borda, além do último ponto.
  return { col: last.col + (last.row % 2 === 0 ? 1 : -1), row: last.row + 0.5, inGrid: false };
}

/**
 * Distribui os pontos reconhecidos na grade: as correntinhas formam a carreira de base e cada ponto
 * trabalhado numa laçada da peça ocupa a próxima casa, sobre o ponto da mesma coluna.
 * `base` é a laçada de cima desse ponto de baixo, onde a agulha deve entrar a seguir;
 * `used` diz se o ponto em andamento já passou por ela.
 */
export function planTapestry(stitches, columns) {
  const places = new Map();
  const cells = new Map();
  let filled = 0;
  let last = null;
  let current = null;

  for (const stitch of stitches) {
    const place = placeStitch(stitch, cellAt(filled, columns), last);
    for (const id of stitch.loops) places.set(id, { stitch, place });
    if (stitch.kind === STITCH.IN_PROGRESS) {
      current = stitch;
    } else if (place.inGrid) {
      cells.set(`${place.col},${place.row}`, stitch);
      filled++;
      last = place;
    }
  }

  const next = cellAt(filled, columns);
  const below = next.row > 0 ? cells.get(`${next.col},${next.row - 1}`) : null;
  const base = below?.top ?? null;
  return { places, next, filled, base, used: base !== null && !!current?.bases.includes(base) };
}

// Correntinhas ficam deitadas no centro da casa (de pé, na borda); pontos com base formam um V,
// com as laçadas do corpo no braço esquerdo e a laçada de cima no direito.
export function restingPlace(grid, { stitch, place }, id) {
  const { x, y } = cellCenter(grid, place.col, place.row);
  if (!stitch.bases.length) {
    return { x, y, angle: place.inGrid || stitch.kind === STITCH.SLIP_KNOT ? 0 : Math.PI / 2 };
  }
  const top = id === stitch.top;
  return { x: x + grid.width * (top ? 0.18 : -0.18), y, angle: top ? -ARM_ANGLE : ARM_ANGLE };
}
