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

async function call(method, path, body) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('sem conexão com o servidor');
  }
  if (response.status === 401 && token) {
    localStorage.removeItem(TOKEN_KEY);
    onSessionLost();
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `o servidor respondeu com erro ${response.status}`);
  return data;
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

// `project` precisa conter `id`; o restante é o estado serializado do trabalho.
export function saveProject(project) {
  return call('PUT', projectPath(project.id), project);
}

export function loadProject(id) {
  return call('GET', projectPath(id));
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
