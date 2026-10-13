// Teste de ponta a ponta no Chrome (modo headless) via DevTools Protocol, sem dependências.
// Uso: com o site e a API rodando (`npm start` e `npm run api`), execute `npm run check:browser`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const URL_APP = process.env.APP_URL ?? 'http://localhost:5173/';
const PORT = 9333;
const OUT = resolve(import.meta.dirname, '..', 'test-results');
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
    await sleep(200);
  }
  throw new Error('Não foi possível conectar ao navegador');
}

function client(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    } else if (data.method === 'Runtime.exceptionThrown') {
      errors.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
    } else if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      errors.push(data.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (data.method === 'Page.javascriptDialogOpening') {
      // Aviso de "sair sem salvar" ao recarregar: aceito para o teste seguir.
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const msgId = ++id;
    pending.set(msgId, (data) => (data.error ? rej(new Error(`${method}: ${data.error.message}`)) : res(data.result)));
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

const profile = mkdtempSync(join(tmpdir(), 'croche-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });
setTimeout(() => {
  console.error('✖ Tempo esgotado: o teste no navegador travou.');
  chrome.kill();
  process.exit(1);
}, 240_000).unref();

let exitCode = 0;
try {
  mkdirSync(OUT, { recursive: true });
  const ws = await connect();
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = client(ws);

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  };
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
  let cursor = { x: 700, y: 450 };
  const moveTo = async (x, y, steps = 20, extra = {}) => {
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', cursor.x + ((x - cursor.x) * i) / steps, cursor.y + ((y - cursor.y) * i) / steps, extra);
      await sleep(16);
    }
    cursor = { x, y };
  };
  const click = async (x, y, button = 'left') => {
    await mouse('mousePressed', x, y, { button, clickCount: 1, buttons: button === 'left' ? 1 : 2 });
    await mouse('mouseReleased', x, y, { button, clickCount: 1 });
  };
  const key = async (type, keyName, code, vk, text, modifiers = 0) =>
    send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: vk, text, modifiers });
  const pressSpace = async () => {
    await key('keyDown', ' ', 'Space', 32, ' ');
    await key('keyUp', ' ', 'Space', 32);
  };
  const yarnPointOnScreen = (index) => evaluate(`(() => {
    const app = window.crocheLivre; const p = app.yarn.points[${index}];
    return app.viewport.toScreen(p.x, p.y);
  })()`);
  const state = () => evaluate(`(() => {
    const app = window.crocheLivre;
    const tip = app.viewport.toScreen(app.needle.x, app.needle.y);
    return {
      tip, angle: app.needle.angle, hooked: app.yarn.isHooked, points: app.yarn.points.length,
      fed: app.yarn.fed, loops: app.yarn.loopCandidates.length, crossings: app.yarn.crossings.length,
      paused: app.paused, zoom: app.viewport.targetZoom, color: app.style.color, tension: app.yarn.tension,
      hint: document.getElementById('hint').textContent,
    };
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  await sleep(1500);

  // 0. Entrar com uma conta nova, para o teste começar sem projetos.
  const askedLogin = await evaluate(`document.getElementById('account').open`);
  check('o jogo pede para entrar na conta', askedLogin);
  await shot('00-entrar.png');
  await evaluate(`(async () => {
    document.getElementById('account-user').value = 'teste-' + Date.now().toString(36);
    document.getElementById('account-password').value = 'senha-de-teste';
    document.getElementById('account-signup').click();
    await window.crocheLivre.ready;
  })()`);
  const account = await evaluate(`({ open: document.getElementById('account').open, name: document.getElementById('account-name').textContent })`);
  check('criar conta entra no jogo', !account.open && account.name.startsWith('teste-'), account.name);

  // 1. Abrir o jogo.
  const helpOpen = await evaluate(`document.getElementById('help').open`);
  check('a ajuda abre na primeira visita', helpOpen);
  await shot('01-ajuda.png');
  await evaluate(`document.getElementById('help').close()`);
  check('o jogo abre sem erros', errors.length === 0, errors.join(' | '));

  // 2. Mover a agulha.
  await moveTo(500, 300);
  await sleep(300);
  let s = await state();
  check('a agulha segue o mouse', Math.hypot(s.tip.x - 500, s.tip.y - 300) < 3, `ponta em ${s.tip.x.toFixed(1)}, ${s.tip.y.toFixed(1)}`);

  await mouse('mouseMoved', 900, 300);
  await sleep(16);
  s = await state();
  check('a agulha se move com suavidade (não teleporta)', s.tip.x < 880, `após 1 quadro: x=${s.tip.x.toFixed(1)}`);
  cursor = { x: 900, y: 300 };
  await sleep(300);

  // Girar com o botão direito.
  const angleBefore = s.angle;
  await mouse('mousePressed', 900, 300, { button: 'right', buttons: 2, clickCount: 1 });
  await moveTo(980, 300, 10, { buttons: 2 });
  await mouse('mouseReleased', 980, 300, { button: 'right', clickCount: 1 });
  await sleep(300);
  s = await state();
  check('arrastar com o botão direito gira a agulha', Math.abs(s.angle - angleBefore) > 0.5, `${angleBefore.toFixed(2)} → ${s.angle.toFixed(2)}`);

  // Clique longe do fio: não pega nada.
  await moveTo(700, 120);
  await sleep(250);
  await click(700, 120);
  await sleep(100);
  s = await state();
  check('clicar longe do fio não engancha a linha', !s.hooked, s.hint);

  // 3–5. Pegar a linha e puxar.
  const grab = await yarnPointOnScreen(44);
  await moveTo(grab.x, grab.y);
  await sleep(300);
  s = await state();
  check('a dica indica que o fio está ao alcance', s.hint.includes('pegar a linha'), s.hint);
  await click(grab.x, grab.y);
  await sleep(150);
  s = await state();
  check('clicar perto do fio engancha a linha', s.hooked);

  const pointsBefore = s.points;
  await moveTo(grab.x - 300, grab.y + 260, 40);
  await sleep(400);
  s = await state();
  check('puxar a linha faz o novelo soltar fio', s.points > pointsBefore && s.fed > 0, `${pointsBefore} → ${s.points} pontos`);
  await shot('02-puxando.png');

  // Passar a ponta do fio por cima do próprio fio forma uma volta.
  const mid = await yarnPointOnScreen(20);
  await moveTo(mid.x - 40, mid.y - 120, 40);
  await moveTo(mid.x + 30, mid.y + 90, 40);
  await sleep(400);
  s = await state();
  check('levar o fio por cima de si mesmo forma uma laçada possível', s.loops > 0, `${s.crossings} cruzamentos, ${s.loops} voltas`);
  await shot('03-lacada.png');

  // Segurar com Shift: o novelo não solta fio e a linha escapa com tensão alta.
  await key('rawKeyDown', 'Shift', 'ShiftLeft', 16, undefined, 8);
  const held = (await state()).points;
  await moveTo(30, 30, 40, { modifiers: 8 });
  await sleep(300);
  s = await state();
  await key('keyUp', 'Shift', 'ShiftLeft', 16);
  check('com Shift o novelo segura o fio e a linha escapa do gancho', s.points === held && !s.hooked, `${held} → ${s.points} pontos, presa: ${s.hooked}`);

  // Zoom pela roda.
  const zoomBefore = s.zoom;
  await mouse('mouseWheel', 700, 450, { deltaX: 0, deltaY: -300 });
  await sleep(500);
  s = await state();
  check('a roda do mouse aproxima', s.zoom > zoomBefore, `${zoomBefore.toFixed(2)} → ${s.zoom.toFixed(2)}`);
  await shot('04-zoom.png');
  await mouse('mouseWheel', 700, 450, { deltaX: 0, deltaY: 300 });
  await sleep(400);

  // Pausa.
  await pressSpace();
  await sleep(200);
  s = await state();
  check('Espaço pausa a simulação', s.paused);
  await shot('05-pausado.png');
  await pressSpace();
  await sleep(100);
  check('Espaço retoma a simulação', !(await state()).paused);

  // Cor do fio.
  const swatch = await evaluate(`(() => { const r = document.querySelector('.swatch[data-id="petroleo"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await click(swatch.x, swatch.y);
  await sleep(100);
  s = await state();
  check('escolher uma cor muda o fio', s.color === '#1f5f6b', s.color);
  const tapOn = async (selector) => {
    const r = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await click(r.x, r.y);
    await sleep(150);
  };
  const tonesOpen = () => evaluate(`!document.getElementById('tones').hidden`);
  const tonesShown = await evaluate(`document.querySelectorAll('#tones-list .swatch').length`);
  check('clicar numa cor abre os tons dela', (await tonesOpen()) && tonesShown === 7, `${tonesShown} tons`);
  await shot('06b-tons.png');
  await tapOn('#tones-list .swatch[data-id="petroleo-escuro-2"]');
  s = await state();
  const toneMarked = await evaluate(`document.querySelector('#tones-list [aria-checked="true"]')?.dataset.id`);
  check('escolher um tom muda o fio para ele', s.color !== '#1f5f6b' && toneMarked === 'petroleo-escuro-2', s.color);
  await tapOn('#swatches .swatch[data-id="petroleo"]');
  s = await state();
  check('clicar de novo na cor fecha os tons e mantém o tom escolhido', !(await tonesOpen()) && s.color !== '#1f5f6b', s.color);
  await tapOn('#swatches .swatch[data-id="petroleo"]');
  await tapOn('#tones-list .swatch[data-id="petroleo"]');
  await tapOn('#hint');
  s = await state();
  check('clicar fora fecha os tons', !(await tonesOpen()) && s.color === '#1f5f6b', s.color);

  // Atalhos não interferem na digitação.
  await evaluate(`document.getElementById('project-name').focus()`);
  await key('keyDown', ' ', 'Space', 32, ' ');
  await key('keyUp', ' ', 'Space', 32);
  await key('keyDown', 'h', 'KeyH', 72, 'h');
  await key('keyUp', 'h', 'KeyH', 72);
  s = await state();
  const name = await evaluate(`document.getElementById('project-name').value`);
  const helpAfterTyping = await evaluate(`document.getElementById('help').open`);
  check('digitar no nome do projeto não aciona atalhos', !s.paused && !helpAfterTyping && name.includes(' h'), JSON.stringify(name));

  // Ctrl+Z sem operações: sem erro.
  await evaluate(`document.getElementById('work').focus()`);
  await key('rawKeyDown', 'z', 'KeyZ', 90, undefined, 2);
  await key('keyUp', 'z', 'KeyZ', 90, undefined, 2);
  await sleep(300);
  s = await state();
  check('Ctrl+Z sem operações avisa que não há o que desfazer', s.hint.includes('Nada para desfazer'), s.hint);

  // Desempenho com fio longo.
  const perf = await evaluate(`(async () => {
    const app = window.crocheLivre;
    const hit = app.yarn.nearest(app.yarn.points[5].x, app.yarn.points[5].y, 30);
    app.yarn.catchAt(hit.index, hit.x, hit.y);
    // Puxa bastante fio para longe e depois o amontoa de volta, criando muitos cruzamentos.
    for (let i = 1; i <= 500; i++) {
      app.yarn.setHook(hit.x - i * 19, hit.y + Math.sin(i / 15) * 200);
      app.yarn.update(1 / 60);
    }
    for (let i = 1; i <= 600; i++) {
      const r = 9500 * (1 - i / 600) + 200;
      app.yarn.setHook(hit.x - r * 0.5 + Math.sin(i / 9) * 260, hit.y + Math.cos(i / 7) * 260);
      app.yarn.update(1 / 60);
    }
    const p = app.yarn.points[app.yarn.hookIndex];
    app.needle.x = app.needle.targetX = p.x;
    app.needle.y = app.needle.targetY = p.y;
    app.viewport.x = p.x;
    app.viewport.y = p.y;
    app.viewport.zoom = app.viewport.targetZoom = 0.35;
    const samples = [];
    for (let i = 0; i < 90; i++) {
      const t0 = performance.now();
      app.frame(1 / 60);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return { points: app.yarn.points.length, crossings: app.yarn.crossings.length, median: samples[45], p95: samples[85] };
  })()`);
  check(
    'com o fio longo, o quadro cabe no tempo de 60 quadros por segundo',
    perf.points > 1000 && perf.p95 < 16,
    `${perf.points} pontos, ${perf.crossings} cruzamentos, mediana ${perf.median.toFixed(2)} ms, p95 ${perf.p95.toFixed(2)} ms`,
  );
  await sleep(200);
  await shot('06-fio-longo.png');

  // ---- Etapas 2 a 5: laçada inicial, pontos, desfazer, salvar e reabrir ----
  const inApp = (body) => evaluate(`(async () => { const app = window.crocheLivre; ${body} })()`);
  const structure = `JSON.stringify({ graph: app.work.graph.toJSON(), log: app.work.log, hook: app.work.hook, closed: [...app.work.closedLoops()] })`;
  const work = () => inApp(`return {
    loops: app.work.loops.size, hook: app.work.hook.length, inserted: app.work.inserted, working: app.yarn.working,
    stitches: app.stitchCount, summary: app.summary, angle: app.needle.angle, zoom: app.viewport.zoom,
    candidates: app.yarn.loopCandidates.length, novelos: app.novelos.length, name: app.project.name,
    hint: document.getElementById('hint').textContent, state: document.getElementById('meta-state').textContent,
    structure: ${structure},
  };`);
  const rightClick = () => click(cursor.x, cursor.y, 'right');
  const ctrl = async (letter, code, vk) => {
    await key('rawKeyDown', letter, code, vk, undefined, 2);
    await key('keyUp', letter, code, vk, undefined, 2);
    await sleep(250);
  };
  const clickElement = async (selector) => {
    const r = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await click(r.x, r.y);
    await sleep(300);
  };

  await send('Page.navigate', { url: URL_APP });
  await sleep(1500);
  cursor = { x: 700, y: 450 };

  // Volta no fio: pegar, puxar e cruzar o fio sobre ele mesmo; depois soltar a linha.
  const grab2 = await yarnPointOnScreen(44);
  await moveTo(grab2.x, grab2.y);
  await sleep(300);
  await click(grab2.x, grab2.y);
  await moveTo(grab2.x - 300, grab2.y + 260, 40);
  await sleep(400);
  const mid2 = await yarnPointOnScreen(20);
  await moveTo(mid2.x - 40, mid2.y - 120, 40);
  await moveTo(mid2.x + 30, mid2.y + 90, 40);
  await sleep(400);
  let w = await work();
  if (!w.working) {
    await click(cursor.x, cursor.y);
    await sleep(700);
  }
  w = await work();
  check('soltar a linha deixa a volta deitada na mesa', w.working || w.candidates > 0, `${w.candidates} voltas`);

  // Ponto mais interno da volta, para enfiar a ponta da agulha.
  const inside = await inApp(`
    const c = app.yarn.loopCandidates[0];
    if (!c) return null;
    const pts = c.outline;
    const contains = (x, y) => {
      let hit = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        if ((pts[i].y > y) !== (pts[j].y > y) && x < ((pts[j].x - pts[i].x) * (y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) hit = !hit;
      }
      return hit;
    };
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    let best = null, bestD = -1;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) {
      for (let y = Math.min(...ys); y <= Math.max(...ys); y += 1) {
        if (!contains(x, y)) continue;
        const d = Math.min(...pts.map((p) => Math.hypot(p.x - x, p.y - y)));
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
    }
    return best && app.viewport.toScreen(best.x, best.y);
  `);
  if (!w.working && inside) {
    await moveTo(inside.x, inside.y, 30);
    await sleep(400);
    w = await work();
    check('com a ponta dentro da volta, a dica oferece a laçada inicial', w.hint.includes('laçada inicial'), w.hint);
    await click(inside.x, inside.y);
    await sleep(300);
  }
  w = await work();
  check('clicar dentro da volta aperta a laçada inicial na agulha', w.loops === 1 && w.hook === 1 && w.working, `${w.loops} laçadas, preso: ${w.working}`);
  await shot('08-lacada-inicial.png');

  // Correntinhas: laçar (clique direito) e recuar a agulha na direção do cabo.
  const back = (world) => {
    const px = world * w.zoom;
    return { x: cursor.x + Math.cos(w.angle) * px, y: cursor.y + Math.sin(w.angle) * px };
  };
  const pullBack = async (world, steps = 10) => {
    const to = back(world);
    await moveTo(to.x, to.y, steps);
  };
  for (let i = 0; i < 5; i++) {
    await rightClick();
    await sleep(120);
    await pullBack(20);
    await sleep(250);
  }
  w = await work();
  check('laçar e puxar várias vezes forma uma sequência de correntinhas ligadas', w.stitches === 5 && w.summary.includes('Correntinha ×5'), `${w.stitches} pontos: ${w.summary}`);
  check('nenhum tipo de ponto precisou ser escolhido', !(await evaluate(`!!document.querySelector('[data-stitch], #stitch-menu')`)));
  await shot('09-correntinhas.png');

  // Ponto baixo: avançar a ponta na correntinha, laçar, puxar por ela, laçar, puxar pelas duas.
  await pullBack(-30, 20);
  await sleep(300);
  w = await work();
  check('avançar a ponta numa laçada da peça insere a agulha', w.inserted !== null, w.hint);
  await rightClick();
  await sleep(120);
  await pullBack(22, 12);
  await sleep(800);
  w = await work();
  check('puxar o fio pela laçada da peça deixa duas laçadas na agulha', w.hook === 2 && w.inserted === null, `${w.hook} na agulha`);
  await rightClick();
  await sleep(120);
  await pullBack(38, 14);
  await sleep(400);
  w = await work();
  check('o ponto baixo é reconhecido pelas operações, sem menu', w.summary.includes('Ponto baixo ×1') && w.hook === 1, w.summary);
  await shot('10-ponto-baixo.png');

  // Trocar a cor no meio do trabalho: as próximas laçadas usam o novo fio, as antigas continuam iguais.
  await clickElement('#swatches .swatch[data-id="cereja"]');
  await moveTo(cursor.x, cursor.y + 1, 2);
  await rightClick();
  await sleep(120);
  await pullBack(20);
  await sleep(300);
  const colors = await inApp(`const loops = [...app.work.loops.values()]; return { first: loops[0].color, last: loops.at(-1).color };`);
  w = await work();
  check('trocar a cor vale para as laçadas seguintes e cria um novo novelo', colors.last === '#b3263a' && colors.first !== colors.last && w.novelos === 2, JSON.stringify(colors));

  // Desfazer e refazer sem corromper a estrutura.
  const beforeUndo = w;
  await evaluate(`document.getElementById('work').focus()`);
  await ctrl('z', 'KeyZ', 90);
  w = await work();
  const undoOne = w.hook === 2 && w.loops === beforeUndo.loops && w.stitches === beforeUndo.stitches - 1;
  await ctrl('z', 'KeyZ', 90);
  w = await work();
  const undoTwo = w.hook === 1 && w.loops === beforeUndo.loops - 1;
  await ctrl('y', 'KeyY', 89);
  await ctrl('y', 'KeyY', 89);
  w = await work();
  check('Ctrl+Z desfaz puxar e laçar; Ctrl+Y refaz e a estrutura volta idêntica', undoOne && undoTwo && w.structure === beforeUndo.structure, `${undoOne} ${undoTwo} ${w.structure === beforeUndo.structure}`);

  // Salvar, recarregar e continuar.
  await ctrl('s', 'KeyS', 83);
  await sleep(400);
  w = await work();
  check('Ctrl+S salva o projeto', w.state === 'Salvo', w.state);
  const saved = w;
  await send('Page.navigate', { url: URL_APP });
  await sleep(1500);
  await evaluate(`window.crocheLivre.ready`);
  await sleep(300);
  w = await work();
  check('recarregar a página reabre o projeto salvo com a mesma estrutura', w.structure === saved.structure && w.state === 'Salvo' && w.name === saved.name, `${w.loops} laçadas, ${w.state}`);
  await shot('11-reaberto.png');
  cursor = await inApp(`return app.viewport.toScreen(app.needle.x, app.needle.y);`);
  await moveTo(cursor.x + 1, cursor.y, 2);
  await rightClick();
  await sleep(120);
  await pullBack(20);
  await sleep(300);
  w = await work();
  check('depois de reabrir, o trabalho continua de onde parou', w.stitches === saved.stitches + 1 && w.state === 'Não salvo', `${saved.stitches} → ${w.stitches}`);

  // Excluir com confirmação.
  await clickElement('#projects-open');
  const listed = await evaluate(`document.querySelectorAll('#project-list li').length`);
  await clickElement('#project-list li .button-danger');
  const confirmOpen = await evaluate(`document.getElementById('confirm').open`);
  await clickElement('#confirm button[value="cancelar"]');
  const keptAfterCancel = await evaluate(`document.querySelectorAll('#project-list li').length`);
  await clickElement('#project-list li .button-danger');
  await clickElement('#confirm-ok');
  await sleep(300);
  const afterDelete = await evaluate(`({ items: document.querySelectorAll('#project-list li').length, empty: !document.getElementById('project-empty').hidden })`);
  await shot('12-projetos.png');
  check('excluir pede confirmação; cancelar mantém e confirmar apaga', listed === 1 && confirmOpen && keptAfterCancel === 1 && afterDelete.items === 0 && afterDelete.empty, JSON.stringify({ listed, confirmOpen, keptAfterCancel, afterDelete }));
  await evaluate(`document.getElementById('projects').close()`);

  // ---- Modo tapeçaria (pixel art) ----
  const press = async (keyName, code, vk) => {
    await key('keyDown', keyName, code, vk, keyName);
    await key('keyUp', keyName, code, vk);
    await sleep(120);
  };
  const tapestry = () => inApp(`
    const plan = app.plan;
    const grid = plan && app.grid;
    const loops = [...app.work.closedLoops()].map((l) => ({ id: l.id, x: l.x, y: l.y, color: l.color }));
    return {
      columns: app.tapestry?.columns, next: plan?.next, base: plan?.base, inserted: app.work.inserted,
      baseClosed: app.work.loops.get(plan?.base)?.state === 'fechada', hook: app.work.hook.length,
      stitches: app.stitchCount, summary: app.summary, loops, grid, angle: app.needle.angle, zoom: app.viewport.zoom,
      mode: document.getElementById('meta-mode').textContent, hint: app.contextHint(),
      structure: ${structure},
    };
  `);

  await clickElement('#tapestry-open');
  const tapestryOpen = await evaluate(`document.getElementById('tapestry').open`);
  await evaluate(`document.getElementById('tapestry-columns').value = '4'`);
  await key('keyDown', 'Enter', 'Enter', 13, '\r');
  await key('keyUp', 'Enter', 'Enter', 13);
  await sleep(300);
  // O trabalho anterior não estava salvo: confirmar antes de trocar.
  if (await evaluate(`document.getElementById('confirm').open`)) await clickElement('#confirm-ok');
  await sleep(300);
  let t = await tapestry();
  check('o botão Tapeçaria cria um projeto de tapeçaria com a largura escolhida', tapestryOpen && t.columns === 4 && t.mode === 'Tapeçaria', `${t.columns} pontos, modo ${t.mode}`);
  await shot('14-tapecaria-inicio.png');

  const grab3 = await yarnPointOnScreen(44);
  await moveTo(grab3.x, grab3.y);
  await sleep(300);
  await click(grab3.x, grab3.y);
  await sleep(200);
  t = await tapestry();
  const hintKnot = t.hint;
  await click(cursor.x, cursor.y);
  await sleep(300);
  w = await work();
  check('na tapeçaria, com a linha no gancho, um clique faz a laçada inicial', hintKnot.includes('laçada inicial') && w.loops === 1 && w.working, hintKnot);

  // Carreira de base: duas correntinhas por gestos e duas pela tecla B.
  for (let i = 0; i < 2; i++) {
    await rightClick();
    await sleep(120);
    await pullBack(20);
    await sleep(250);
  }
  await press('b', 'KeyB', 66);
  await press('b', 'KeyB', 66);
  t = await tapestry();
  check('no fim da carreira de base, a dica pede a correntinha de virar', t.stitches === 4 && !t.baseClosed && t.hint.includes('virar'), t.hint);

  await press('b', 'KeyB', 66);
  t = await tapestry();
  check('a tecla B faz a correntinha de virar e destaca o ponto de baixo', t.baseClosed && t.next.row === 1 && t.hint.includes('Carreira 1, ponto 1 de 4'), t.hint);
  // Laçadas 2 a 5 são as quatro correntinhas da base (a 1 é a laçada inicial).
  const row0 = t.loops.slice(1, 5);
  const evenSpacing = row0.length === 4 && row0.every((l, i) => Math.abs(l.y - t.grid.y0) < 1e-6 && Math.abs(l.x - (t.grid.x0 + i * t.grid.width)) < 1e-6);
  check('as correntinhas da base ficam uma ao lado da outra, em casas iguais', evenSpacing, row0.map((l) => `${l.x.toFixed(1)},${l.y.toFixed(1)}`).join(' '));
  await shot('15-tapecaria-base.png');

  // Primeiro ponto baixo por gestos, em outra cor: avançar (insere sozinho), laçar, puxar, laçar, puxar.
  await press('2', 'Digit2', 50);
  w = await work();
  await pullBack(-30, 20);
  await sleep(300);
  t = await tapestry();
  const insertedBase = t.inserted !== null && t.inserted === t.base;
  await rightClick();
  await sleep(120);
  await pullBack(22, 12);
  await sleep(800);
  await rightClick();
  await sleep(120);
  await pullBack(38, 14);
  await sleep(400);
  t = await tapestry();
  check('avançar a agulha entra sozinha no ponto de baixo, sem mirar', insertedBase);
  check('o ponto baixo feito por gestos é reconhecido e vai para a próxima casa', t.summary.includes('Ponto baixo ×1') && t.next.col === 2 && t.next.row === 1, `${t.summary}; próxima casa ${JSON.stringify(t.next)}`);

  // O resto da carreira com a tecla B, trocando a cor pelo número.
  await press('1', 'Digit1', 49);
  await press('b', 'KeyB', 66);
  await press('2', 'Digit2', 50);
  await press('b', 'KeyB', 66);
  await press('1', 'Digit1', 49);
  await press('b', 'KeyB', 66);
  await press('b', 'KeyB', 66);
  t = await tapestry();
  const row1Y = t.grid.y0 - t.grid.height;
  const row1 = t.loops.filter((l) => Math.abs(l.y - row1Y) < 1e-6);
  const columnsOk = [0, 1, 2, 3].every((c) => {
    const cx = t.grid.x0 + c * t.grid.width;
    return row1.filter((l) => Math.abs(l.x - cx) < t.grid.width / 2).length === 2;
  });
  check(
    'a carreira 1 fica alinhada sobre a base: duas laçadas (o V do ponto) em cada coluna',
    t.summary.includes('Ponto baixo ×4') && row1.length === 8 && columnsOk,
    `${t.summary}; ${row1.length} laçadas na carreira 1`,
  );
  const reds = row1.filter((l) => l.color === '#b3263a').length;
  check('cada ponto sai na cor escolhida antes dele', reds === 4, `${reds} laçadas cereja`);

  const beforeUndoT = t;
  await evaluate(`document.getElementById('work').focus()`);
  await ctrl('z', 'KeyZ', 90);
  t = await tapestry();
  const undoneT = t.stitches === beforeUndoT.stitches - 1 && t.inserted === null && t.hook === 1;
  await ctrl('y', 'KeyY', 89);
  t = await tapestry();
  check('Ctrl+Z desfaz o ponto inteiro da tecla B e Ctrl+Y refaz igual', undoneT && t.structure === beforeUndoT.structure, `${beforeUndoT.stitches} → desfeito ${undoneT} → ${t.stitches}`);

  await ctrl('s', 'KeyS', 83);
  await sleep(300);
  const savedT = await tapestry();
  await send('Page.navigate', { url: URL_APP });
  await sleep(1500);
  await evaluate(`window.crocheLivre.ready`);
  await sleep(300);
  t = await tapestry();
  check('a tapeçaria salva reabre no mesmo modo, com a mesma estrutura', t.columns === 4 && t.structure === savedT.structure && t.mode === 'Tapeçaria', `${t.columns} pontos, ${t.stitches} pontos feitos`);

  // Renomear pela lista de projetos: Enter confirma, Esc desiste, e nada mais muda.
  const listed2 = () => evaluate(`(() => {
    const item = document.querySelector('#project-list li.is-current');
    return {
      open: document.getElementById('projects').open, name: item.querySelector('strong')?.textContent,
      date: item.querySelector('small').textContent, editing: !!item.querySelector('.project-rename'),
      current: window.crocheLivre.project.name, header: document.getElementById('project-name').value,
      state: document.getElementById('meta-state').textContent,
    };
  })()`);
  await clickElement('#projects-open');
  const beforeRename = await listed2();
  await clickElement('#project-list li.is-current button');
  const editing = (await listed2()).editing;
  const pressRaw = async (keyName, code, vk) => {
    await key('rawKeyDown', keyName, code, vk);
    await key('keyUp', keyName, code, vk);
  };
  await send('Input.insertText', { text: 'Snoopy de teste' });
  await pressRaw('Enter', 'Enter', 13);
  await sleep(300);
  const renamed = await listed2();
  check(
    'Renomear na lista muda o nome salvo e o da tela, sem marcar o projeto como não salvo',
    editing && renamed.open && renamed.name === 'Snoopy de teste' && renamed.current === 'Snoopy de teste'
      && renamed.header === 'Snoopy de teste' && renamed.state === 'Salvo' && renamed.date === beforeRename.date,
    JSON.stringify(renamed),
  );
  await clickElement('#project-list li.is-current button');
  await send('Input.insertText', { text: 'Outro nome' });
  await pressRaw('Escape', 'Escape', 27);
  await sleep(300);
  const cancelled = await listed2();
  check('Esc desiste de renomear sem fechar a lista', cancelled.open && !cancelled.editing && cancelled.name === 'Snoopy de teste', JSON.stringify(cancelled));
  await evaluate(`document.getElementById('projects').close()`);
  t = await tapestry();
  check('renomear não mexe no trabalho salvo', t.structure === savedT.structure);

  // Projeto aberto depois que um trabalho vazio já foi desenhado: os dois começam na versão 0.
  const redrawn = await inApp(`
    const id = app.project.id;
    app.startProject();
    app.frame(1 / 60);
    await app.openProject(id, { silent: true });
    app.frame(1 / 60);
    const fabric = app.renderer.fabric;
    return { hasPiece: fabric.bounds !== null, painted: fabric.closed.size, closed: [...app.work.closedLoops()].length };
  `);
  check(
    'abrir um projeto salvo sempre desenha a peça inteira',
    redrawn.hasPiece && redrawn.closed > 0 && redrawn.painted === redrawn.closed,
    JSON.stringify(redrawn),
  );

  // Um desenho maior, para ver as casas como pixels.
  const drawing = await inApp(`
    app.startProject({ tapestry: { columns: 12 } });
    const art = [
      '............',
      '...XX..XX...',
      '..XXXXXXXX..',
      '..XXXXXXXX..',
      '...XXXXXX...',
      '....XXXX....',
      '.....XX.....',
      '............',
    ];
    const hit = app.yarn.nearest(app.yarn.points[40].x, app.yarn.points[40].y, 20);
    app.yarn.catchAt(hit.index, app.needle.throat.x, app.needle.throat.y);
    app.pickColor(6);
    app.tieSlipKnot(null);
    for (let i = 0; i < 12; i++) app.quickStitch();
    for (let r = 1; r < art.length; r++) {
      app.pickColor(6);
      app.quickStitch();
      for (let i = 0; i < 12; i++) {
        const col = app.plan.next.col;
        app.pickColor(art[art.length - r][col] === 'X' ? 1 : 6);
        app.quickStitch();
      }
    }
    app.viewport.x = app.grid.x0 + app.grid.width * 5.5;
    app.viewport.y = app.grid.y0 - app.grid.height * 4;
    app.viewport.zoom = app.viewport.targetZoom = 2;
    app.needle.placeAt(app.grid.x0 + 400, app.grid.y0 - 100, Math.PI / 4);
    return { stitches: app.stitchCount, summary: app.summary, next: app.plan.next };
  `);
  await sleep(500);
  await shot('16-tapecaria-desenho.png');
  check('um desenho em pixels inteiro sai com a tecla B e as cores', drawing.summary.includes(`Ponto baixo ×${12 * 7}`) && drawing.next.row === 8, `${drawing.summary}`);

  // Peça grande: milhares de laçadas e ligações, com câmera parada e em movimento.
  const big = await inApp(`
    app.startProject();
    const w = app.work, look = app.look(), run = (op) => app.history.run(op);
    const pull = (n, place) => run(w.pullThrough(n, new Map(w.pullSequence().slice(0, n).map((id, k) => [id, place(k)]))));
    run(w.slipKnot({ x: 0, y: 0, angle: 0, look, size: 10 }));
    const W = 60, ROWS = 20, S = 20;
    let row = [];
    for (let i = 0; i < W; i++) {
      run(w.yarnOver({ look, size: 10 }));
      pull(1, () => ({ x: i * S, y: 0, angle: 0 }));
      row.push(w.log.at(-1).closed[0]);
    }
    for (let r = 1; r <= ROWS; r++) {
      const next = [];
      for (let i = 0; i < W; i++) {
        const x = (r % 2 ? W - 1 - i : i) * S;
        w.insert(row[W - 1 - i]);
        run(w.yarnOver({ look, size: 10 }));
        pull(1, () => ({}));
        run(w.yarnOver({ look, size: 10 }));
        pull(2, (k) => ({ x: x + k * 7, y: r * S - k * 5, angle: Math.PI / 2 }));
        next.push(w.log.at(-1).closed[0]);
      }
      row = next;
    }
    app.updateRecognition(false);
    app.viewport.x = (W * S) / 2;
    app.viewport.y = (ROWS * S) / 2;
    app.viewport.zoom = app.viewport.targetZoom = 1;
    app.needle.placeAt(-80, -60, Math.PI / 4);
    const measure = (before) => {
      const samples = [];
      for (let i = 0; i < 90; i++) {
        before();
        const t0 = performance.now();
        app.frame(1 / 60);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return { median: samples[45], p95: samples[85] };
    };
    const still = measure(() => {});
    const panning = measure(() => app.viewport.panBy(4, 0));
    app.viewport.x = (W * S) / 2;
    app.frame(1 / 60);
    let k = 0;
    const stitch = measure(() => {
      run(w.yarnOver({ look, size: 10 }));
      pull(1, () => ({ x: 40 + (k++ % 50) * S, y: -12, angle: 0 }));
    });
    const undo = measure(() => app.history.undo());
    return { loops: w.loops.size, edges: w.graph.edges.length, stitches: app.stitchCount, still, panning, stitch, undo };
  `);
  check(
    'uma peça grande continua leve com a câmera parada',
    big.loops > 2000 && big.still.p95 < 12,
    `${big.loops} laçadas, ${big.edges} ligações, ${big.stitches} pontos; mediana ${big.still.median.toFixed(2)} ms, p95 ${big.still.p95.toFixed(2)} ms`,
  );
  check(
    'e continua fluida movendo a câmera',
    big.panning.p95 < 16,
    `mediana ${big.panning.median.toFixed(2)} ms, p95 ${big.panning.p95.toFixed(2)} ms`,
  );
  check(
    'fazer pontos numa peça grande não pesa (só as laçadas novas são desenhadas)',
    big.stitch.p95 < 16,
    `mediana ${big.stitch.median.toFixed(2)} ms, p95 ${big.stitch.p95.toFixed(2)} ms`,
  );
  check(
    'desfazer numa peça grande redesenha tudo em tempo aceitável',
    big.undo.median < 100,
    `mediana ${big.undo.median.toFixed(2)} ms, p95 ${big.undo.p95.toFixed(2)} ms`,
  );
  await sleep(200);
  await shot('13-peca-grande.png');

  // Tela pequena.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await shot('07-celular.png');
  const overflow = await evaluate(`[...document.querySelectorAll('.materials, .tools, .hint-bar, .brand-bar')].some((el) => { const r = el.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 1; })`);
  check('painéis cabem em tela pequena', !overflow);

  // Sair da conta e entrar de novo.
  const username = await evaluate(`document.getElementById('account-name').textContent`);
  await evaluate(`document.getElementById('account-open').click()`);
  await sleep(300);
  await evaluate(`document.getElementById('confirm-ok').click()`);
  await sleep(800);
  const left = await evaluate(`({ asked: document.getElementById('account').open, loops: window.crocheLivre.work.loops.size, hidden: document.getElementById('account-open').hidden })`);
  check('sair da conta limpa a tela e pede para entrar de novo', left.asked && left.loops === 0 && left.hidden, JSON.stringify(left));
  const enterWith = (password) => evaluate(`(() => {
    document.getElementById('account-user').value = ${JSON.stringify(username)};
    document.getElementById('account-password').value = ${JSON.stringify(password)};
    document.getElementById('account-login').click();
  })()`);
  await enterWith('senha-errada');
  await sleep(1500);
  const wrong = await evaluate(`({ open: document.getElementById('account').open, error: document.getElementById('account-error').textContent })`);
  check('senha errada não entra e explica o motivo', wrong.open && wrong.error.includes('incorretos'), wrong.error);
  await enterWith('senha-de-teste');
  await sleep(2000);
  const reentered = await evaluate(`({ open: document.getElementById('account').open, loops: window.crocheLivre.work.loops.size, state: document.getElementById('meta-state').textContent })`);
  check('entrar de novo reabre o último projeto da conta', !reentered.open && reentered.loops > 0 && reentered.state === 'Salvo', JSON.stringify(reentered));

  check('nenhum erro no console', errors.length === 0, errors.join(' | '));
  ws.close();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} verificações passaram. Capturas em ${OUT}`);
process.exit(failed || exitCode ? 1 : 0);
