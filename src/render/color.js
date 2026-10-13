const shadeCache = new Map();

// Clareia (amount > 0) ou escurece (amount < 0) uma cor hexadecimal.
export function shade(hex, amount, alpha = 1) {
  const key = `${hex}|${amount}|${alpha}`;
  let value = shadeCache.get(key);
  if (value) return value;
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  value = `rgba(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)}, ${alpha})`;
  shadeCache.set(key, value);
  return value;
}
