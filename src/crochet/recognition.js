export const STITCH = {
  SLIP_KNOT: 'lacada-inicial',
  CHAIN: 'correntinha',
  SLIP: 'ponto-baixissimo',
  SINGLE: 'ponto-baixo',
  HALF_DOUBLE: 'meio-ponto-alto',
  DOUBLE: 'ponto-alto',
  TREBLE: 'ponto-alto-duplo',
  SINGLE_DECREASE: 'diminuicao-ponto-baixo',
  FREE: 'livre',
  IN_PROGRESS: 'em-andamento',
};

export const STITCH_NAMES = {
  [STITCH.SLIP_KNOT]: 'Laçada inicial',
  [STITCH.CHAIN]: 'Correntinha',
  [STITCH.SLIP]: 'Ponto baixíssimo',
  [STITCH.SINGLE]: 'Ponto baixo',
  [STITCH.HALF_DOUBLE]: 'Meio ponto alto',
  [STITCH.DOUBLE]: 'Ponto alto',
  [STITCH.TREBLE]: 'Ponto alto duplo',
  [STITCH.SINGLE_DECREASE]: 'Diminuição em ponto baixo',
  [STITCH.FREE]: 'Criação livre',
  [STITCH.IN_PROGRESS]: 'Em andamento',
};

// L = laçar, I = inserir a agulha numa laçada do trabalho, Pn = puxar através de n laçadas
// (sufixo f quando a primeira atravessada é a laçada do trabalho).
const SIGNATURES = new Map([
  ['L P1', STITCH.CHAIN],
  ['I L P2f', STITCH.SLIP],
  ['I L P1f L P2', STITCH.SINGLE],
  ['L I L P1f L P3', STITCH.HALF_DOUBLE],
  ['L I L P1f L P2 L P2', STITCH.DOUBLE],
  ['L L I L P1f L P2 L P2 L P2', STITCH.TREBLE],
  ['I L P1f I L P1f L P3', STITCH.SINGLE_DECREASE],
]);

/**
 * Agrupa o registro de operações em pontos: cada ponto começa e termina com uma única laçada na agulha.
 * A classificação vem da sequência de operações, nunca do desenho; o que não corresponde a uma
 * assinatura conhecida fica como criação livre.
 */
export function recognizeStitches(log) {
  const stitches = [];
  let onHook = 0;
  let current = null;

  const begin = () => {
    current ??= { tokens: [], loops: [], bases: [], into: null };
    return current;
  };

  for (const entry of log) {
    if (entry.type === 'inicial') {
      stitches.push({ kind: STITCH.SLIP_KNOT, loops: [entry.loop], top: entry.loop, bases: [], signature: '' });
      onHook = 1;
      continue;
    }

    const stitch = begin();
    if (entry.type === 'lacar') {
      if (entry.into !== null && entry.into !== stitch.into) {
        stitch.tokens.push('I');
        stitch.bases.push(entry.into);
        stitch.into = entry.into;
      }
      stitch.tokens.push('L');
      stitch.loops.push(entry.loop);
      onHook += 1;
    } else if (entry.type === 'puxar') {
      const through = entry.through !== null;
      stitch.tokens.push(`P${entry.closed.length + (through ? 1 : 0)}${through ? 'f' : ''}`);
      if (through) stitch.into = null;
      onHook -= entry.closed.length;

      if (onHook === 1) {
        const signature = stitch.tokens.join(' ');
        stitches.push({
          kind: SIGNATURES.get(signature) ?? STITCH.FREE,
          loops: stitch.loops,
          top: entry.loop,
          bases: stitch.bases,
          signature,
        });
        current = null;
      }
    }
  }

  if (current) {
    stitches.push({ kind: STITCH.IN_PROGRESS, loops: current.loops, top: null, bases: current.bases, signature: current.tokens.join(' ') });
  }
  return stitches;
}

// Contagem por tipo e quantos pontos foram trabalhados numa base já usada (aumentos).
export function summarize(stitches) {
  const counts = new Map();
  const usedBases = new Set();
  let increases = 0;
  for (const stitch of stitches) {
    counts.set(stitch.kind, (counts.get(stitch.kind) ?? 0) + 1);
    for (const base of stitch.bases) {
      if (usedBases.has(base)) increases++;
      usedBases.add(base);
    }
  }
  return { counts, increases };
}
