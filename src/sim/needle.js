import { clamp, damp, dampAngle, wrapAngle } from '../core/math.js';

export const FOLLOW_RATE = 20;
const TURN_RATE = 10;
const LEAN_PER_SPEED = 0.0007;
const MAX_LEAN = 0.35;

// Garganta do gancho em coordenadas locais (x aponta da ponta para o cabo).
const THROAT = { x: 9, y: -1.6 };

// A agulha persegue o alvo do mouse com amortecimento; `x`/`y` é a ponta do gancho.
export class Needle {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.targetX = x;
    this.targetY = y;
    this.vx = 0;
    this.vy = 0;
    this.followRate = FOLLOW_RATE;
    // Direção da ponta para o cabo; o cabo começa apontando para baixo e à direita, como numa mão direita.
    this.baseAngle = Math.PI / 4;
    this.lean = 0;
    this.angle = this.baseAngle;
  }

  setTarget(x, y) {
    this.targetX = x;
    this.targetY = y;
  }

  placeAt(x, y, baseAngle = this.baseAngle) {
    this.x = this.prevX = this.targetX = x;
    this.y = this.prevY = this.targetY = y;
    this.vx = this.vy = this.lean = 0;
    this.baseAngle = this.angle = baseAngle;
  }

  rotate(radians) {
    this.baseAngle = wrapAngle(this.baseAngle + radians);
  }

  update(dt) {
    if (dt <= 0) return;
    this.prevX = this.x;
    this.prevY = this.y;
    this.x = damp(this.x, this.targetX, this.followRate, dt);
    this.y = damp(this.y, this.targetY, this.followRate, dt);

    const vx = (this.x - this.prevX) / dt;
    const vy = (this.y - this.prevY) / dt;
    this.vx = damp(this.vx, vx, 12, dt);
    this.vy = damp(this.vy, vy, 12, dt);

    // O cabo se inclina na direção do movimento, como uma ferramenta conduzida pela mão.
    const hx = Math.cos(this.baseAngle);
    const hy = Math.sin(this.baseAngle);
    const leanTarget = clamp((hx * this.vy - hy * this.vx) * LEAN_PER_SPEED, -MAX_LEAN, MAX_LEAN);
    this.lean = damp(this.lean, leanTarget, 8, dt);
    this.angle = dampAngle(this.angle, this.baseAngle + this.lean, TURN_RATE, dt);
  }

  get throat() {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    return {
      x: this.x + THROAT.x * cos - THROAT.y * sin,
      y: this.y + THROAT.x * sin + THROAT.y * cos,
    };
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }
}
