import { Viewport } from './camera/viewport.js';
import { clamp, damp, dist, pointInPolygon } from './core/math.js';
import { History } from './crochet/history.js';
import { STITCH, STITCH_NAMES, recognizeStitches, summarize } from './crochet/recognition.js';
import { clampColumns, planTapestry, restingPlace, tapestryGrid } from './crochet/tapestry.js';
import { STATE, Work } from './crochet/work.js';
import { Controls } from './input/controls.js';
import {
  createAccount,
  currentUser,
  deleteProject,
  listProjects,
  loadProject,
  login,
  logout,
  renameProject,
  saveProject,
  whenSessionLost,
} from './persist/api.js';
import { newProjectId, parseProject, serializeProject } from './persist/project.js';
import { loadSettings, saveSettings } from './persist/settings.js';
import { Renderer } from './render/renderer.js';
import { loopSize, loopYarnLength } from './sim/loops.js';
import { YARN_COLORS, noveloKey, resolveStyle } from './sim/materials.js';
import { Needle } from './sim/needle.js';
import { Stitching } from './sim/stitching.js';
import { Yarn } from './sim/yarn.js';
import { confirmAction, createAccountDialog, createProjectsDialog, createSettingsDialog, createTapestryDialog } from './ui/dialogs.js';
import { createPanel, describeNovelo } from './ui/panel.js';

const REACH_PX = 18;
const TRANSIENT_HINT_TIME = 2.4;
const CROSS_SKIP_RADIUS = 3;
const MAX_NOVELOS = 8;
const ROTATE_STEP = 0.12;
// Pontos do fio junto à garganta: tocar ali não conta como pegar o fio de trabalho para laçar.
const YARN_OVER_SKIP = 3;
const BALL = { x: 300, y: 170, radius: 44 };
const START_NEEDLE = { x: -140, y: -60, angle: Math.PI / 4 };
const DISCARD_MESSAGE = 'As mudanças deste projeto que ainda não foram salvas serão perdidas.';

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.viewport = new Viewport();
    this.renderer = new Renderer(canvas);
    this.ball = { ...BALL };
    this.settings = loadSettings();
    this.style = resolveStyle();
    this.needle = new Needle();
    this.needle.followRate = this.settings.followRate;
    this.history = new History({ onChange: (h) => this.ui.setHistory(h) });

    this.pointer = null;
    this.paused = false;
    this.time = 0;
    this.reach = null;
    this.tensionShown = 0;
    this.transientHint = null;
    this.changes = 0;
    this.savedChanges = 0;

    this.ui = createPanel({
      style: this.style,
      onColor: (c) => this.setStyle({ colorId: c.id }),
      onThickness: (t) => this.setStyle({ thicknessId: t.id }),
      onMaterial: (m) => this.setStyle({ materialId: m.id }),
      onNovelo: (style) => this.useNovelo(style),
      onRename: (name) => this.rename(name),
      onTool: (id) => this.onTool(id),
    });
    this.projects = createProjectsDialog({
      onOpen: (project) => this.openProject(project.id),
      onRename: (project, name) => this.renameSaved(project, name),
      onDelete: (project) => this.removeProject(project),
      onNew: () => this.newProject(),
      onTapestry: () => this.tapestryDialog.show(),
    });
    this.settingsDialog = createSettingsDialog(this.settings, (change) => this.changeSettings(change));
    this.tapestryDialog = createTapestryDialog((columns) => this.newTapestry(clampColumns(columns)));
    this.account = createAccountDialog((form) => this.enter(form));
    this.controls = new Controls(canvas, this);

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.startProject();
    window.addEventListener('beforeunload', (event) => {
      if (this.dirty) event.preventDefault();
    });
    // O trabalho na tela continua: depois de entrar de novo, basta salvar.
    whenSessionLost(() => this.account.show('Sua sessão expirou. Entre de novo para continuar; o trabalho na tela não se perde.'));
    this.ready = this.start();
  }

  get dirty() {
    return this.changes !== this.savedChanges;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.viewport.resize(width, height, dpr);
    this.renderer.resize(width, height, dpr);
  }

  // ---- Projeto ----

  // Substitui todo o estado do trabalho: projeto novo (sem argumentos) ou carregado de `parseProject`.
  startProject(state = {}) {
    const { viewport } = this;
    this.project = state.project ?? { id: newProjectId(), name: 'Novo trabalho', createdAt: Date.now() };
    this.work = state.work ?? new Work();
    this.yarn = state.yarn ?? new Yarn({
      anchorX: BALL.x - BALL.radius * 0.8,
      anchorY: BALL.y - BALL.radius * 0.4,
      towardX: -60,
      towardY: 40,
    });
    this.yarn.holding = this.controls.holding;
    this.workTime = state.workTime ?? 0;
    this.tapestry = state.tapestry ?? null;
    this.style = resolveStyle(state.style ?? this.style);
    this.novelos = (state.novelos ?? []).map(resolveStyle);
    const needle = state.needle ?? START_NEEDLE;
    this.needle.placeAt(needle.x, needle.y, needle.angle);
    this.pointer = null;

    const camera = state.camera ?? (this.tapestry ? this.tapestryCamera() : {
      x: 80,
      y: 50,
      zoom: clamp(Math.min(viewport.width, viewport.height) / 760, 0.6, 1.2),
    });
    viewport.x = camera.x;
    viewport.y = camera.y;
    viewport.zoom = viewport.targetZoom = clamp(camera.zoom, 0.35, 4);
    viewport.anchor = null;

    this.stitching = new Stitching();
    this.history.clear();
    this.effects = [];
    this.lastCross = new Map();
    this.hadLoop = false;
    this.savedAt = state.savedAt ?? null;
    this.changes = this.savedChanges = 0;
    this.ui.setProjectName(this.project.name);
    this.ui.selectStyle(this.style);
    this.updateRecognition(false);
  }

  // Enquadra a carreira de base e algumas carreiras acima dela.
  tapestryCamera() {
    const grid = this.grid;
    const span = grid.columns * grid.width;
    return {
      x: grid.x0 + span / 2 - grid.width / 2,
      y: grid.y0 - grid.height * 3,
      zoom: clamp((this.viewport.width * 0.6) / span, 0.35, 1.4),
    };
  }

  // A grade segue a espessura da laçada inicial; antes dela, a do fio escolhido.
  get grid() {
    const knot = this.work.loops.get(this.work.log[0]?.loop);
    return tapestryGrid(this.tapestry.columns, knot?.thickness ?? this.style.thickness);
  }

  // ---- Conta ----

  async start() {
    try {
      this.user = await currentUser();
    } catch (error) {
      this.flash(`Não foi possível conferir a sua conta: ${error.message}`, true);
    }
    if (this.user) this.ui.setUser(this.user);
    else await this.account.show();
    this.ui.openHelpOnce();
    await this.restoreLatest();
  }

  async enter({ username, password, creating }) {
    this.user = await (creating ? createAccount : login)(username, password);
    this.ui.setUser(this.user);
    this.flash(creating ? `Conta criada. Boas-vindas, ${this.user}!` : `Olá, ${this.user}!`);
  }

  async leave() {
    const ok = await confirmAction({
      title: 'Sair da conta?',
      message: this.dirty ? DISCARD_MESSAGE : 'Seus projetos continuam guardados na conta para quando você voltar.',
      confirmLabel: 'Sair',
    });
    if (!ok) return;
    try {
      await logout();
    } catch (error) {
      // A sessão já foi esquecida neste aparelho; no servidor, ela vence sozinha.
      console.warn('Não foi possível encerrar a sessão no servidor:', error);
    }
    this.user = null;
    this.ui.setUser(null);
    this.startProject();
    await this.account.show();
    await this.restoreLatest();
  }

  async restoreLatest() {
    try {
      const [latest] = await listProjects();
      if (latest && !this.dirty && !this.work.started) await this.openProject(latest.id, { silent: true });
    } catch (error) {
      this.flash(`Não foi possível ler os projetos salvos: ${error.message}`, true);
    }
  }

  async saveCurrent() {
    const changes = this.changes;
    const data = structuredClone(serializeProject({
      project: this.project,
      workTime: this.workTime,
      tapestry: this.tapestry,
      style: this.style,
      novelos: this.novelos,
      work: this.work,
      yarn: this.yarn,
      needle: this.needle,
      viewport: this.viewport,
    }));
    try {
      await saveProject(data);
      this.savedChanges = changes;
      this.savedAt = Date.now();
      this.flash('Projeto salvo na sua conta.');
    } catch (error) {
      this.flash(`Não foi possível salvar: ${error.message}`, true);
    }
  }

  async openProject(id, { silent = false } = {}) {
    if (!silent && this.dirty) {
      const ok = await confirmAction({ title: 'Abrir outro projeto?', message: DISCARD_MESSAGE, confirmLabel: 'Abrir mesmo assim' });
      if (!ok) return;
    }
    try {
      const data = await loadProject(id);
      if (!data) throw new Error('ele não existe mais');
      this.startProject({ ...parseProject(data), savedAt: data.updatedAt });
      if (this.projects.open) this.projects.close();
      this.flash(`Projeto “${this.project.name}” aberto.`);
    } catch (error) {
      this.flash(`Não foi possível abrir o projeto: ${error.message}.`, true);
    }
  }

  async showProjects() {
    try {
      this.projects.show(await listProjects(), this.savedAt ? this.project.id : null);
    } catch (error) {
      this.flash(`Não foi possível listar os projetos: ${error.message}`, true);
    }
  }

  async renameSaved(project, name) {
    try {
      await renameProject(project.id, name);
      // O nome salvo e o da tela continuam iguais: renomear não deixa o projeto aberto "Não salvo".
      if (project.id === this.project.id) {
        this.project.name = name;
        this.ui.setProjectName(name);
      }
      this.flash(`Projeto “${project.name}” agora se chama “${name}”.`);
      await this.showProjects();
    } catch (error) {
      this.flash(`Não foi possível renomear: ${error.message}`, true);
    }
  }

  async removeProject(project) {
    const ok = await confirmAction({
      title: 'Excluir projeto?',
      message: `“${project.name}” será apagado da sua conta. Isso não pode ser desfeito.`,
      confirmLabel: 'Excluir',
    });
    if (!ok) return;
    try {
      await deleteProject(project.id);
      // O trabalho aberto continua na tela, mas passa a ser um projeto ainda não salvo.
      if (project.id === this.project.id) {
        this.project = { ...this.project, id: newProjectId() };
        this.savedAt = null;
        this.savedChanges = -1;
      }
      this.flash(`Projeto “${project.name}” excluído.`);
      await this.showProjects();
    } catch (error) {
      this.flash(`Não foi possível excluir: ${error.message}`, true);
    }
  }

  async newProject() {
    if (this.dirty) {
      const ok = await confirmAction({ title: 'Começar um projeto novo?', message: DISCARD_MESSAGE, confirmLabel: 'Começar novo' });
      if (!ok) return;
    }
    this.startProject();
    if (this.projects.open) this.projects.close();
    this.flash('Projeto novo: pegue a linha para começar.');
  }

  async newTapestry(columns) {
    if (this.dirty) {
      const ok = await confirmAction({ title: 'Começar uma tapeçaria?', message: DISCARD_MESSAGE, confirmLabel: 'Começar tapeçaria' });
      if (!ok) return;
    }
    this.startProject({
      project: { id: newProjectId(), name: 'Nova tapeçaria', createdAt: Date.now() },
      tapestry: { columns },
    });
    if (this.projects.open) this.projects.close();
    this.flash(`Tapeçaria de ${columns} pontos por carreira: pegue a linha com a agulha e clique de novo para a laçada inicial.`);
  }

  rename(name) {
    this.project.name = name || 'Sem nome';
    this.markDirty();
  }

  markDirty() {
    this.changes++;
  }

  // ---- Fio e novelos ----

  setStyle(change) {
    this.style = resolveStyle({ ...this.style, ...change });
    if (this.work.started) this.markDirty();
  }

  useNovelo(style) {
    this.style = resolveStyle(style);
    this.ui.selectStyle(this.style);
    if (this.work.started) this.markDirty();
  }

  registerNovelo(style) {
    const key = noveloKey(style);
    if (this.novelos.length >= MAX_NOVELOS || this.novelos.some((n) => noveloKey(n) === key)) return false;
    this.novelos.push(resolveStyle(style));
    return true;
  }

  keepNovelo() {
    if (this.registerNovelo(this.style)) {
      this.markDirty();
      this.flash(`Novelo guardado: ${describeNovelo(this.style)}.`);
    } else if (this.novelos.length >= MAX_NOVELOS) {
      this.flash(`Cabem até ${MAX_NOVELOS} novelos por projeto.`, true);
    } else {
      this.flash('Esse novelo já está guardado.');
    }
  }

  pickColor(index) {
    const color = YARN_COLORS[index];
    if (!color) return;
    this.setStyle({ colorId: color.id });
    this.ui.selectStyle(this.style);
    this.flash(`Cor do fio: ${color.name}.`);
  }

  look() {
    return { color: this.style.color, thickness: this.style.thickness, materialId: this.style.materialId };
  }

  changeSettings(change) {
    Object.assign(this.settings, change);
    this.needle.followRate = this.settings.followRate;
    saveSettings(this.settings);
  }

  // ---- Intenções vindas dos controles ----

  pointerMove(sx, sy) {
    this.pointer = { x: sx, y: sy };
  }

  primary() {
    if (this.paused) {
      this.flash('A simulação está pausada. Pressione Espaço para continuar.', true);
      return;
    }
    const { needle, yarn } = this;
    if (this.work.started) {
      this.yarnOver(true);
      return;
    }
    const candidate = this.candidateAtTip();
    if (candidate) {
      this.tieSlipKnot(candidate);
      return;
    }
    if (yarn.isHooked) {
      if (this.tapestry) this.tieSlipKnot(null);
      else this.releaseYarn();
      return;
    }

    const hit = yarn.nearest(needle.x, needle.y, this.reachRadius());
    if (!hit) {
      this.addEffect(needle.x, needle.y, 'alert');
      this.flash('A ponta da agulha não alcança o fio. Aproxime mais o gancho.', true);
      return;
    }
    const throat = needle.throat;
    yarn.catchAt(hit.index, throat.x, throat.y);
    this.addEffect(hit.x, hit.y, 'catch');
  }

  rotate(radians) {
    if (!this.paused) this.needle.rotate(radians);
  }

  contextAction() {
    if (this.paused) return;
    if (this.work.started) this.yarnOver(false);
    else if (this.yarn.isHooked) this.releaseYarn();
    else this.flash('Arraste com o botão direito para girar a agulha.');
  }

  zoom(sx, sy, factor) {
    this.viewport.zoomAt(sx, sy, factor);
  }

  pan(dsx, dsy) {
    this.viewport.panBy(dsx, dsy);
  }

  setHolding(holding) {
    this.yarn.holding = holding;
  }

  action(name) {
    const { viewport } = this;
    const color = /^color(\d)$/.exec(name);
    if (color) {
      this.pickColor(Number(color[1]) - 1);
      return;
    }
    switch (name) {
      case 'pause':
        this.paused = !this.paused;
        break;
      case 'undo': {
        const operation = this.history.undo();
        if (operation) this.afterHistoryJump(`Desfeito: ${operation.label}.`);
        else this.flash('Nada para desfazer ainda.');
        break;
      }
      case 'redo': {
        const operation = this.history.redo();
        if (operation) this.afterHistoryJump(`Refeito: ${operation.label}.`);
        else this.flash('Nada para refazer.');
        break;
      }
      case 'zoomIn':
        viewport.zoomAt(viewport.width / 2, viewport.height / 2, 1.25);
        break;
      case 'zoomOut':
        viewport.zoomAt(viewport.width / 2, viewport.height / 2, 0.8);
        break;
      case 'zoomReset':
        viewport.zoomTo(1);
        break;
      case 'rotateLeft':
        this.rotate(-ROTATE_STEP);
        break;
      case 'rotateRight':
        this.rotate(ROTATE_STEP);
        break;
      case 'save':
        this.saveCurrent();
        break;
      case 'projects':
        this.showProjects();
        break;
      case 'settings':
        this.settingsDialog.show();
        break;
      case 'keepNovelo':
        this.keepNovelo();
        break;
      case 'tapestry':
        this.tapestryDialog.show();
        break;
      case 'quickStitch':
        this.quickStitch();
        break;
      case 'help':
        this.ui.openHelp();
        break;
      case 'account':
        this.leave();
        break;
    }
  }

  onTool(id) {
    const actions = {
      save: 'save',
      'projects-open': 'projects',
      undo: 'undo',
      redo: 'redo',
      'zoom-in': 'zoomIn',
      'zoom-out': 'zoomOut',
      'zoom-reset': 'zoomReset',
      'settings-open': 'settings',
      'novelo-add': 'keepNovelo',
      'tapestry-open': 'tapestry',
      'help-open': 'help',
      'account-open': 'account',
    };
    this.action(actions[id]);
  }

  // ---- Operações do crochê ----

  candidateAtTip() {
    const { needle } = this;
    return this.yarn.loopCandidates.find((c) => pointInPolygon(needle.x, needle.y, c.outline)) ?? null;
  }

  // A volta de fio fechada vira a laçada inicial na garganta; desfazer devolve o fio como estava.
  // Sem volta (`candidate` nulo, modo tapeçaria), a laçada é feita direto no gancho.
  tieSlipKnot(candidate) {
    const { needle, yarn, work } = this;
    const throat = needle.throat;
    const outline = candidate?.outline.map(({ x, y }) => ({ x, y }));
    const size = loopSize(this.style.thickness, yarn.tension);
    const rope = candidate ? yarn.tieKnot(candidate, throat.x, throat.y) : yarn.tieAtHook();
    const knot = work.slipKnot({ x: throat.x, y: throat.y, angle: needle.angle, look: this.look(), size });
    this.history.run({
      label: knot.label,
      apply: () => {
        yarn.restore(rope.after);
        knot.apply();
      },
      revert: () => {
        knot.revert();
        yarn.restore(rope.before);
      },
    });
    if (outline) this.effects.push({ kind: 'shrink', outline, x: throat.x, y: throat.y, age: 0, life: 0.45 });
    else this.addEffect(throat.x, throat.y, 'catch');
    this.registerNovelo(this.style);
    this.flash(this.tapestry
      ? 'Laçada inicial feita! Agora a carreira de base: lace o fio (clique direito) e recue a agulha, ou aperte B.'
      : 'Laçada inicial feita! Agora lace o fio e recue a agulha para puxar.');
    this.afterChange(false);
  }

  // Pelo clique esquerdo, laçar exige a ponta encostada no fio que vem do novelo.
  yarnOver(needTouch) {
    const { needle, yarn, work } = this;
    if (needTouch) {
      const hit = yarn.nearest(needle.x, needle.y, this.reachRadius());
      if (!hit || hit.index > yarn.hookIndex - YARN_OVER_SKIP) {
        this.addEffect(needle.x, needle.y, 'alert');
        this.flash('Para laçar, encoste a ponta no fio que vem do novelo e clique, ou use o clique direito.', true);
        return;
      }
    }
    if (work.hookIsFull) {
      this.addEffect(needle.x, needle.y, 'alert');
      this.flash('A agulha está cheia: puxe o fio através das laçadas antes de laçar de novo.', true);
      return;
    }
    const size = loopSize(this.style.thickness, yarn.tension);
    this.history.run(work.yarnOver({ look: this.look(), size }));
    yarn.consume(loopYarnLength(size));
    const throat = needle.throat;
    this.addEffect(throat.x, throat.y, 'catch');
    this.registerNovelo(this.style);
    this.afterChange(false);
  }

  onStitchEvent(event) {
    const { work } = this;
    if (event.type === 'insert') {
      work.insert(event.id);
      const loop = work.loops.get(event.id);
      this.addEffect(loop.x, loop.y, 'catch');
    } else if (event.type === 'withdraw') {
      work.withdraw();
    } else if (event.type === 'pass') {
      const loop = work.loops.get(event.id);
      this.addEffect(loop.x, loop.y, 'cross');
    } else if (event.type === 'pull') {
      this.history.run(work.pullThrough(event.count, this.tapestry ? this.settle(event.positions) : event.positions));
      this.stitching.ignoreUntilLeft(work.log[work.log.length - 1].closed);
      this.afterChange(true);
    }
  }

  // No modo tapeçaria, cada laçada fechada assenta na sua casa da grade, não onde estava na agulha.
  settle(positions) {
    const plan = planTapestry(recognizeStitches(this.work.log), this.tapestry.columns);
    const grid = this.grid;
    for (const id of positions.keys()) {
      const entry = plan.places.get(id);
      if (entry) positions.set(id, restingPlace(grid, entry, id));
    }
    return positions;
  }

  // Tecla B do modo tapeçaria: o próximo ponto inteiro (ponto baixo, ou correntinha quando a carreira
  // pede), feito com as mesmas operações dos gestos e desfeito de uma vez.
  quickStitch() {
    const { work, plan } = this;
    if (this.paused) {
      this.flash('A simulação está pausada. Pressione Espaço para continuar.', true);
      return;
    }
    if (!plan) {
      this.flash('A tecla B faz pontos inteiros só no modo tapeçaria (botão Tapeçaria).');
      return;
    }
    if (!work.started) {
      this.flash('Faça a laçada inicial antes: pegue a linha com a agulha e clique de novo.', true);
      return;
    }
    if (work.hook.length > 1 || (work.inserted !== null && work.inserted !== plan.base)) {
      this.flash('Termine o ponto em andamento antes de usar a tecla B.', true);
      return;
    }

    const single = work.loops.get(plan.base)?.state === STATE.CLOSED;
    if (single) work.insert(plan.base);
    const size = loopSize(this.style.thickness, this.yarn.tension);
    const steps = [];
    const step = (operation) => {
      operation.apply();
      steps.push(operation);
    };
    const yarnOver = () => {
      step(work.yarnOver({ look: this.look(), size }));
      this.yarn.consume(loopYarnLength(size));
    };
    const pull = (count) => {
      const ids = work.pullSequence().slice(0, count);
      step(work.pullThrough(count, this.settle(new Map(ids.map((id) => [id, null])))));
    };
    yarnOver();
    pull(1);
    if (single) {
      yarnOver();
      pull(2);
    }
    for (const operation of [...steps].reverse()) operation.revert();
    this.history.run({
      label: single ? 'ponto baixo' : 'correntinha',
      apply: () => {
        for (const operation of steps) operation.apply();
      },
      revert: () => {
        for (const operation of [...steps].reverse()) operation.revert();
        work.withdraw();
      },
    });
    this.registerNovelo(this.style);
    this.stitching.reset();
    this.afterChange(true);
  }

  afterChange(announce) {
    this.markDirty();
    this.updateRecognition(announce);
  }

  afterHistoryJump(text) {
    this.stitching.reset();
    this.markDirty();
    this.updateRecognition(false);
    // Desfazer pode mudar o ponto de baixo; a agulha não fica numa laçada que não é mais a base.
    if (this.plan && this.work.inserted !== null && this.work.inserted !== this.plan.base) this.work.withdraw();
    this.flash(text);
  }

  // O reconhecimento relê o registro de operações inteiro: desfazer e refazer nunca deixam contagens velhas.
  updateRecognition(announce) {
    const stitches = recognizeStitches(this.work.log);
    const done = stitches.filter((s) => s.kind !== STITCH.IN_PROGRESS && s.kind !== STITCH.SLIP_KNOT);
    const { counts, increases } = summarize(done);
    this.stitchCount = done.length;
    this.plan = this.tapestry ? planTapestry(stitches, this.tapestry.columns) : null;
    const parts = [...counts].map(([kind, n]) => `${STITCH_NAMES[kind]} ×${n}`);
    if (increases) parts.push(`Aumentos ×${increases}`);
    this.summary = parts.join(' · ');

    const last = stitches[stitches.length - 1];
    const entry = this.work.log[this.work.log.length - 1];
    if (!announce || !last || last.kind === STITCH.IN_PROGRESS || last.top !== entry?.loop) return;
    const name = STITCH_NAMES[last.kind];
    if (this.settings.stitchNames) {
      const throat = this.needle.throat;
      this.effects.push({ kind: 'label', text: name, x: throat.x, y: throat.y, age: 0, life: 1.6 });
    }
    this.flash(last.kind === STITCH.FREE
      ? 'Criação livre: essa sequência não corresponde a um ponto conhecido, e ela fica registrada assim.'
      : `Ponto reconhecido: ${name.toLowerCase()}.`);
  }

  // ---- Simulação ----

  reachRadius() {
    return REACH_PX / this.viewport.zoom + this.style.thickness / 2;
  }

  releaseYarn() {
    const p = this.yarn.points[this.yarn.hookIndex];
    this.yarn.release();
    this.addEffect(p.x, p.y, 'catch');
  }

  addEffect(x, y, kind) {
    this.effects.push({ x, y, kind, age: 0, life: kind === 'cross' ? 0.45 : 0.6 });
  }

  // Mensagem passageira; some antes do tempo se a situação do jogador mudar.
  flash(text, alert = false) {
    this.transientHint = { text, alert, context: this.contextHint(), until: this.time + TRANSIENT_HINT_TIME };
  }

  frame(dt) {
    this.time += dt;
    if (window.devicePixelRatio !== this.viewport.dpr) this.resize();
    this.viewport.update(dt);
    if (!this.paused) this.simulate(dt);
    this.updateReach();
    this.updateUi(dt);

    const { work, needle, style } = this;
    this.renderer.render({
      viewport: this.viewport,
      ball: this.ball,
      yarn: this.yarn,
      needle,
      style,
      work,
      hover: this.stitching.hover,
      tapestry: this.plan && { grid: this.grid, next: this.plan.next },
      pullGuide: this.settings.pullGuide && !this.paused ? this.stitching.pullGuide(work, needle, style.thickness) : null,
      spares: this.novelos.filter((n) => noveloKey(n) !== noveloKey(style)),
      effects: this.effects,
      reach: this.reach,
      paused: this.paused,
      time: this.time,
    }, dt);
  }

  simulate(dt) {
    const { needle, yarn, work } = this;
    this.workTime += dt;

    if (this.pointer) {
      const target = this.viewport.toWorld(this.pointer.x, this.pointer.y);
      if (yarn.working && yarn.holding) this.limitReach(target);
      needle.setTarget(target.x, target.y);
    }

    const before = needle.throat;
    needle.update(dt);
    const after = needle.throat;

    const target = this.plan ? (this.plan.used ? null : this.plan.base) : undefined;
    for (const event of this.stitching.update(dt, work, needle, this.style.thickness, target)) this.onStitchEvent(event);

    if (yarn.isHooked) {
      yarn.setHook(after.x, after.y);
      this.detectHookCrossings(before, after);
    }
    yarn.update(dt);

    for (const event of yarn.drainEvents()) {
      if (event.type === 'slip') {
        this.addEffect(event.x, event.y, 'alert');
        this.flash('A linha escapou do gancho: a tensão ficou alta demais.', true);
      } else if (event.type === 'feed-limit') {
        this.flash('O fio chegou ao comprimento máximo desta versão.', true);
      }
    }

    const hasLoop = yarn.loopCandidates.length > 0;
    if (hasLoop && !this.hadLoop) this.flash('O fio fechou uma volta: leve a ponta para dentro dela e clique para fazer a laçada inicial.');
    this.hadLoop = hasLoop;

    for (const e of this.effects) e.age += dt;
    this.effects = this.effects.filter((e) => e.age < e.life);
  }

  // Com a linha segurada e presa ao trabalho, a agulha não vai além do fio disponível.
  limitReach(target) {
    const { anchor } = this.yarn;
    const max = this.yarn.maxReach();
    const d = dist(anchor.x, anchor.y, target.x, target.y);
    if (d <= max) return;
    target.x = anchor.x + ((target.x - anchor.x) * max) / d;
    target.y = anchor.y + ((target.y - anchor.y) * max) / d;
  }

  // A linha presa no gancho passou por cima de outro trecho do fio.
  detectHookCrossings(from, to) {
    const hits = this.yarn.segmentsCrossedBy(from.x, from.y, to.x, to.y, this.yarn.hookIndex, CROSS_SKIP_RADIUS);
    for (const hit of hits) {
      const last = this.lastCross.get(hit.index) ?? -Infinity;
      if (this.time - last > 0.25) this.addEffect(hit.x, hit.y, 'cross');
      this.lastCross.set(hit.index, this.time);
    }
  }

  updateReach() {
    const { needle, yarn } = this;
    if (yarn.isHooked) {
      const throat = needle.throat;
      this.reach = { x: throat.x, y: throat.y, hooked: true };
      return;
    }
    const hit = this.paused ? null : yarn.nearest(needle.x, needle.y, this.reachRadius());
    this.reach = hit && { x: hit.x, y: hit.y, hooked: false };
  }

  contextHint() {
    const { yarn, work } = this;
    if (this.paused) return 'Simulação pausada. Pressione Espaço para continuar.';
    if (work.started) {
      if (work.canPull) {
        const n = work.pullSequence().length;
        return n === 1
          ? 'Volta na garganta: recue a agulha na direção do cabo para puxá-la pela laçada.'
          : `Volta na garganta: recue a agulha para puxá-la por uma laçada de cada vez (até ${n}).`;
      }
      if (work.inserted !== null) return 'Agulha dentro de uma laçada da peça: lace o fio para puxá-lo por ela.';
      if (work.hook.length > 1) return `${work.hook.length} laçadas na agulha: lace o fio e puxe através delas.`;
      if (this.plan) return this.tapestryHint();
      if (this.stitching.hover) return 'Laçada da peça sob a ponta: saia e avance para dentro dela para inserir a agulha.';
      return 'Lace o fio (clique direito) e recue a agulha, ou avance a ponta numa laçada da peça.';
    }
    if (this.candidateAtTip()) return 'Ponta dentro da volta: clique para apertar a laçada inicial.';
    if (yarn.loopCandidates.length) return 'Volta formada: leve a ponta da agulha para dentro dela e clique. Se o fio atrapalhar, solte a linha antes.';
    if (yarn.isHooked && this.tapestry) return 'Linha no gancho: clique para fazer a laçada inicial da tapeçaria.';
    if (yarn.isHooked && yarn.holding) return 'Segurando a linha: o novelo não solta fio. Puxe com cuidado para ela não escapar.';
    if (yarn.isHooked) return 'Linha no gancho. Cruze o fio sobre ele mesmo para fechar uma volta; clique para soltar.';
    if (this.reach && !this.reach.hooked) return 'Clique para pegar a linha com o gancho.';
    return 'Leve a ponta da agulha até o fio.';
  }

  tapestryHint() {
    const { next, base } = this.plan;
    const { columns } = this.tapestry;
    if (next.row === 0) {
      return `Carreira de base: faltam ${columns - next.col} correntinhas. Lace o fio (clique direito) e recue a agulha, ou aperte B.`;
    }
    if (this.work.loops.get(base)?.state !== STATE.CLOSED) {
      return 'Fim da carreira: faça uma correntinha para virar o trabalho (clique direito e recue), ou aperte B.';
    }
    const position = next.row % 2 === 0 ? next.col + 1 : columns - next.col;
    return `Carreira ${next.row}, ponto ${position} de ${columns}: avance a agulha para entrar no ponto destacado, ou aperte B para o ponto baixo inteiro.`;
  }

  updateUi(dt) {
    const context = this.contextHint();
    const transient = this.transientHint;
    if (transient && this.time < transient.until && transient.context === context) {
      this.ui.setHint(transient.text, transient.alert);
    } else {
      this.transientHint = null;
      this.ui.setHint(context);
    }

    this.tensionShown = damp(this.tensionShown, this.yarn.tension, 10, dt);
    this.ui.setTension(this.tensionShown);
    this.ui.setZoom(this.viewport.targetZoom);
    this.ui.setNovelos(this.novelos, this.style);
    this.ui.setMeta({
      time: this.workTime,
      loops: this.work.loops.size,
      stitches: this.stitchCount,
      mode: this.tapestry ? 'Tapeçaria' : 'Livre',
      state: this.paused ? 'Pausado' : this.dirty ? 'Não salvo' : this.savedAt ? 'Salvo' : 'Novo',
      summary: this.summary,
    });
  }
}
