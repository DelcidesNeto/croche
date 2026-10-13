export const TAU = Math.PI * 2;

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Suavização independente da taxa de quadros: quanto maior `rate`, mais rápido alcança o alvo.
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function dampAngle(current, target, rate, dt) {
  return current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt));
}

export function distSq(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function dist(ax, ay, bx, by) {
  return Math.sqrt(distSq(ax, ay, bx, by));
}

export function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq === 0 ? 0 : clamp(((px - ax) * abx + (py - ay) * aby) / lenSq, 0, 1);
  const x = ax + abx * t;
  const y = ay + aby * t;
  return { x, y, t, d2: distSq(px, py, x, y) };
}

// Interseção estrita entre os segmentos AB e CD; devolve null se forem paralelos ou não se cruzarem.
export function segmentIntersection(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;

  const qx = cx - ax;
  const qy = cy - ay;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;

  return { x: ax + rx * t, y: ay + ry * t, t, u, side: Math.sign(denom) };
}

export function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return Math.abs(area) / 2;
}

export function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
