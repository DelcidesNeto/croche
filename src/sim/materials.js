const BASE_COLORS = [
  { id: 'mostarda', name: 'Mostarda', value: '#d9a21b' },
  { id: 'cereja', name: 'Cereja', value: '#b3263a' },
  { id: 'rosa-antigo', name: 'Rosa antigo', value: '#d98f95' },
  { id: 'musgo', name: 'Verde-musgo', value: '#5d7a35' },
  { id: 'petroleo', name: 'Azul-petróleo', value: '#1f5f6b' },
  { id: 'anil', name: 'Anil', value: '#33449a' },
  { id: 'cru', name: 'Cru', value: '#efe6d2' },
  { id: 'grafite', name: 'Grafite', value: '#3b3f44' },
  { id: 'telha', name: 'Telha', value: '#c0623a' },
];

// Quanto cada tom puxa para o branco ou para o preto, do mais próximo da cor ao mais distante.
const LIGHTER = [0.2, 0.4, 0.6];
const DARKER = [0.18, 0.36, 0.54];

function mix(hex, target, amount) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift) => {
    const c = (n >> shift) & 255;
    return Math.round(c + (target - c) * amount).toString(16).padStart(2, '0');
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

// Cada cor tem sete tons, do mais claro ao mais escuro; o do meio é a própria cor e mantém o id dela,
// então projetos salvos antes dos tons continuam com o mesmo fio.
export const YARN_COLORS = BASE_COLORS.map((color) => ({
  ...color,
  tones: [
    ...LIGHTER.map((amount, i) => ({ id: `${color.id}-claro-${i + 1}`, name: `${color.name} (tom claro ${i + 1})`, value: mix(color.value, 255, amount) })).reverse(),
    color,
    ...DARKER.map((amount, i) => ({ id: `${color.id}-escuro-${i + 1}`, name: `${color.name} (tom escuro ${i + 1})`, value: mix(color.value, 0, amount) })),
  ],
}));

const YARN_TONES = YARN_COLORS.flatMap((family) => family.tones);

export function colorFamily(colorId) {
  return YARN_COLORS.find((family) => family.tones.some((tone) => tone.id === colorId)) ?? YARN_COLORS[0];
}

export const THICKNESSES = [
  { id: 'fino', name: 'Fino', value: 5 },
  { id: 'medio', name: 'Médio', value: 8 },
  { id: 'grosso', name: 'Grosso', value: 12 },
];

// Por enquanto os materiais mudam apenas a aparência do fio, não a física.
export const MATERIALS = [
  { id: 'algodao', name: 'Algodão', twist: 0.42, fuzz: 0, sheen: 0.28 },
  { id: 'la', name: 'Lã', twist: 0.22, fuzz: 0.5, sheen: 0.12 },
  { id: 'acrilico', name: 'Acrílico', twist: 0.32, fuzz: 0.12, sheen: 0.5 },
];

export function materialById(id) {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
}

// Monta o estilo completo a partir dos ids; ids desconhecidos (projetos antigos) caem no padrão.
export function resolveStyle({ colorId, thicknessId, materialId } = {}) {
  const color = YARN_TONES.find((c) => c.id === colorId) ?? YARN_COLORS[0];
  const thickness = THICKNESSES.find((t) => t.id === thicknessId) ?? THICKNESSES[1];
  const material = materialById(materialId);
  return {
    colorId: color.id,
    color: color.value,
    colorName: color.name,
    thicknessId: thickness.id,
    thickness: thickness.value,
    thicknessName: thickness.name,
    materialId: material.id,
    material,
  };
}

export function noveloKey({ colorId, thicknessId, materialId }) {
  return `${colorId}|${thicknessId}|${materialId}`;
}
