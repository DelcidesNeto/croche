// Contas e projetos ficam no Worker da Cloudflare (pasta `api/`); aqui só fica o token da sessão.
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const API_URL = LOCAL_HOSTS.includes(location.hostname)
  ? 'http://localhost:8787'
  : 'https://croche-livre-api.delcides-c-c-neto.workers.dev';
const TOKEN_KEY = 'croche-livre:sessao';

let onSessionLost = () => {};

// Chamado quando o servidor recusa o token guardado (sessão vencida ou encerrada em outro lugar).
export function whenSessionLost(callback) {
  onSessionLost = callback;
}

async function request(method, path, { body, headers = {} } = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { method, headers, body });
  } catch {
    throw new Error('sem conexão com o servidor');
  }
  if (response.status === 401 && token) {
    localStorage.removeItem(TOKEN_KEY);
    onSessionLost();
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? `o servidor respondeu com erro ${response.status}`);
  }
  return response;
}

async function call(method, path, body) {
  const response = await request(method, path, body === undefined
    ? {}
    : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return response.status === 204 ? null : response.json();
}

async function enter(path, username, password) {
  const { token, username: name } = await call('POST', path, { username, password });
  localStorage.setItem(TOKEN_KEY, token);
  return name;
}

export const createAccount = (username, password) => enter('/accounts', username, password);
export const login = (username, password) => enter('/session', username, password);

// Nome da pessoa com sessão aberta, ou `null` se ainda for preciso entrar.
export async function currentUser() {
  if (!localStorage.getItem(TOKEN_KEY)) return null;
  try {
    return (await call('GET', '/session')).username;
  } catch (error) {
    if (!localStorage.getItem(TOKEN_KEY)) return null;
    throw error;
  }
}

export async function logout() {
  try {
    await call('DELETE', '/session');
  } finally {
    localStorage.removeItem(TOKEN_KEY);
  }
}

const projectPath = (id) => `/projects/${encodeURIComponent(id)}`;

// O projeto viaja e fica guardado compactado (gzip em base64): cabe muito mais e o envio é menor.
async function pack(project) {
  const zipped = new Blob([JSON.stringify(project)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(zipped).arrayBuffer()).toBase64();
}

function unpack(text) {
  const unzipped = new Blob([Uint8Array.fromBase64(text)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(unzipped).json();
}

// `project` precisa conter `id`; o restante é o estado serializado do trabalho.
export async function saveProject(project) {
  await request('PUT', projectPath(project.id), {
    body: await pack(project),
    headers: { 'Content-Type': 'text/plain', 'X-Project-Name': encodeURIComponent(project.name) },
  });
}

export async function loadProject(id) {
  const response = await request('GET', projectPath(id));
  let project;
  try {
    project = await unpack(await response.text());
  } catch {
    throw new Error('o projeto salvo está corrompido');
  }
  return {
    ...project,
    name: decodeURIComponent(response.headers.get('X-Project-Name')),
    updatedAt: Number(response.headers.get('X-Updated-At')),
  };
}

export function listProjects() {
  return call('GET', '/projects');
}

// Muda só o nome: o trabalho e a data de salvamento ficam como estão, então a ordem da lista não muda.
export function renameProject(id, name) {
  return call('PATCH', projectPath(id), { name });
}

export function deleteProject(id) {
  return call('DELETE', projectPath(id));
}
