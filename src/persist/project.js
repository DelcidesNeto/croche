import { COLUMNS } from '../crochet/tapestry.js';
import { Work } from '../crochet/work.js';
import { Yarn } from '../sim/yarn.js';

export const PROJECT_VERSION = 1;

export function newProjectId() {
  return `projeto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const pickStyle = ({ colorId, thicknessId, materialId }) => ({ colorId, thicknessId, materialId });

export function serializeProject({ project, workTime, tapestry, style, novelos, work, yarn, needle, viewport }) {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    version: PROJECT_VERSION,
    workTime,
    tapestry: tapestry && { columns: tapestry.columns },
    style: pickStyle(style),
    novelos: novelos.map(pickStyle),
    work: work.toJSON(),
    yarn: yarn.snapshot(),
    needle: { x: needle.x, y: needle.y, angle: needle.baseAngle },
    camera: { x: viewport.x, y: viewport.y, zoom: viewport.targetZoom },
  };
}

// Reconstrói e valida tudo antes de substituir o projeto aberto; qualquer falha vira um Error legível.
export function parseProject(data) {
  if (!data || typeof data.id !== 'string') throw new Error('o arquivo do projeto está vazio ou corrompido');
  if (data.version > PROJECT_VERSION) throw new Error('o projeto foi salvo por uma versão mais nova do jogo');

  const work = Work.fromJSON(data.work);
  const yarn = Yarn.fromSnapshot(data.yarn);
  if (work.started !== yarn.working) throw new Error('o fio salvo não corresponde ao trabalho');

  const finite = (...values) => values.every(Number.isFinite);
  const needle = data.needle && finite(data.needle.x, data.needle.y, data.needle.angle) ? data.needle : null;
  const camera = data.camera && finite(data.camera.x, data.camera.y, data.camera.zoom) ? data.camera : null;
  // Projetos sem o campo são do modo livre.
  const columns = data.tapestry?.columns;
  if (data.tapestry && !(Number.isInteger(columns) && columns >= COLUMNS.min && columns <= COLUMNS.max)) {
    throw new Error('a largura da tapeçaria salva é inválida');
  }

  return {
    project: { id: data.id, name: String(data.name ?? 'Sem nome'), createdAt: data.createdAt ?? Date.now() },
    workTime: Number.isFinite(data.workTime) ? data.workTime : 0,
    tapestry: data.tapestry ? { columns } : null,
    style: data.style ?? {},
    novelos: Array.isArray(data.novelos) ? data.novelos : [],
    work,
    yarn,
    needle,
    camera,
  };
}
