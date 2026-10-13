import { App } from './app.js';

const MAX_FRAME_TIME = 0.05;

const app = new App(document.getElementById('work'));
window.crocheLivre = app;

let last = performance.now();
function loop(now) {
  const dt = Math.min(Math.max(now - last, 0) / 1000, MAX_FRAME_TIME);
  last = now;
  app.frame(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
