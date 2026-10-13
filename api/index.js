// Contas e projetos do Crochê Livre. O site (GitHub Pages) fala com este Worker por HTTP,
// enviando o token da sessão no cabeçalho `Authorization: Bearer <token>`.

const SESSION_DAYS = 30;
// O Workers aceita no máximo 100 mil iterações de PBKDF2.
const PBKDF2_ITERATIONS = 100_000;
// O projeto chega compactado em base64 e vira pedaços de texto: o D1 guarda até 2 MB por linha.
const CHUNK_CHARS = 1_500_000;
// Cerca de 22 MB compactados; o lote de escrita fica bem abaixo do limite de consultas por pedido.
const MAX_PROJECT_CHARS = 30_000_000;
const USERNAME = /^[a-z0-9._-]{3,30}$/;
const PROJECT_ID = /^[\w-]{1,80}$/;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 200;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (body, status = 200) => Response.json(body, { status });
const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
}

async function hashToken(token) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

async function readCredentials(request) {
  const body = await request.json().catch(() => null);
  const username = String(body?.username ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  if (!username || !password) throw new HttpError(400, 'preencha o usuário e a senha');
  return { username, password };
}

async function startSession(env, userId, username) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, now),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await hashToken(token), userId, now + SESSION_DAYS * 86_400_000),
  ]);
  return json({ token, username });
}

async function createAccount(request, env) {
  const { username, password } = await readCredentials(request);
  if (!USERNAME.test(username)) {
    throw new HttpError(400, 'o usuário deve ter de 3 a 30 caracteres, só com letras sem acento, números, ponto, hífen ou sublinhado');
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new HttpError(400, `a senha deve ter pelo menos ${MIN_PASSWORD} caracteres`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt);
  const user = await env.DB.prepare(`
    INSERT INTO users (username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (username) DO NOTHING RETURNING id
  `).bind(username, toHex(hash), toHex(salt), Date.now()).first();
  if (!user) throw new HttpError(409, 'esse nome de usuário já está em uso');
  return startSession(env, user.id, username);
}

async function login(request, env) {
  const { username, password } = await readCredentials(request);
  const user = await env.DB.prepare('SELECT id, password_hash, password_salt FROM users WHERE username = ?')
    .bind(username).first();
  const hash = user && await hashPassword(password, fromHex(user.password_salt));
  if (!user || !crypto.subtle.timingSafeEqual(hash, fromHex(user.password_hash))) {
    throw new HttpError(401, 'usuário ou senha incorretos');
  }
  return startSession(env, user.id, username);
}

async function authenticate(request, env) {
  const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  const session = token && await env.DB.prepare(`
    SELECT sessions.token_hash, users.id, users.username FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(await hashToken(token), Date.now()).first();
  if (!session) throw new HttpError(401, 'a sessão expirou, entre de novo');
  return session;
}

// O conteúdo é opaco aqui: quem compacta, confere e descompacta é o navegador.
async function readProject(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_PROJECT_CHARS) {
    throw new HttpError(413, 'o projeto ficou grande demais para ser salvo');
  }
  const text = await request.text();
  if (text.length > MAX_PROJECT_CHARS) throw new HttpError(413, 'o projeto ficou grande demais para ser salvo');
  if (!text) throw new HttpError(400, 'o projeto enviado está vazio');
  let name;
  try {
    name = decodeURIComponent(request.headers.get('X-Project-Name') ?? '').trim().slice(0, 60);
  } catch {
    throw new HttpError(400, 'o nome do projeto veio corrompido');
  }
  const chunks = [];
  for (let start = 0; start < text.length; start += CHUNK_CHARS) chunks.push(text.slice(start, start + CHUNK_CHARS));
  return { chunks, name: name || 'Sem nome' };
}

async function projects(request, env, user, id) {
  const { DB } = env;
  const method = request.method;

  if (id === undefined && method === 'GET') {
    const { results } = await DB.prepare(
      'SELECT id, name, updated_at AS updatedAt FROM projects WHERE user_id = ? ORDER BY updated_at DESC',
    ).bind(user.id).all();
    return json(results);
  }
  if (id === undefined || !PROJECT_ID.test(id)) throw new HttpError(404, 'endereço não encontrado');

  if (method === 'GET') {
    const [project, chunks] = await DB.batch([
      DB.prepare('SELECT name, updated_at FROM projects WHERE user_id = ? AND id = ?').bind(user.id, id),
      DB.prepare('SELECT data FROM project_chunks WHERE user_id = ? AND project_id = ? ORDER BY seq').bind(user.id, id),
    ]);
    const row = project.results[0];
    if (!row || !chunks.results.length) throw new HttpError(404, 'ele não existe mais');
    // O nome fica fora do conteúdo compactado para renomear sem reescrever o projeto.
    return new Response(chunks.results.map((chunk) => chunk.data).join(''), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Project-Name': encodeURIComponent(row.name),
        'X-Updated-At': String(row.updated_at),
      },
    });
  }
  if (method === 'PUT') {
    const { chunks, name } = await readProject(request);
    const updatedAt = Date.now();
    await DB.batch([
      DB.prepare(`
        INSERT INTO projects (user_id, id, name, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (user_id, id) DO UPDATE SET name = ?3, updated_at = ?4
      `).bind(user.id, id, name, updatedAt),
      DB.prepare('DELETE FROM project_chunks WHERE user_id = ? AND project_id = ?').bind(user.id, id),
      ...chunks.map((data, seq) => DB.prepare(
        'INSERT INTO project_chunks (user_id, project_id, seq, data) VALUES (?, ?, ?, ?)',
      ).bind(user.id, id, seq, data)),
    ]);
    return json({ updatedAt });
  }
  if (method === 'PATCH') {
    const body = await request.json().catch(() => null);
    const name = String(body?.name ?? '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'o nome não pode ficar vazio');
    // Muda só o nome: a data de salvamento fica como está, então a ordem da lista não muda.
    const { meta } = await DB.prepare('UPDATE projects SET name = ? WHERE user_id = ? AND id = ?').bind(name, user.id, id).run();
    if (!meta.changes) throw new HttpError(404, 'ele não existe mais');
    return new Response(null, { status: 204 });
  }
  if (method === 'DELETE') {
    await DB.batch([
      DB.prepare('DELETE FROM project_chunks WHERE user_id = ? AND project_id = ?').bind(user.id, id),
      DB.prepare('DELETE FROM projects WHERE user_id = ? AND id = ?').bind(user.id, id),
    ]);
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, 'operação não permitida');
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === '/accounts' && method === 'POST') return createAccount(request, env);
  if (pathname === '/session' && method === 'POST') return login(request, env);

  const user = await authenticate(request, env);
  if (pathname === '/session' && method === 'GET') return json({ username: user.username });
  if (pathname === '/session' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.token_hash).run();
    return new Response(null, { status: 204 });
  }
  const project = /^\/projects(?:\/([^/]+))?$/.exec(pathname);
  if (project) return projects(request, env, user, project[1]);
  throw new HttpError(404, 'endereço não encontrado');
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Project-Name',
    'Access-Control-Expose-Headers': 'X-Project-Name, X-Updated-At',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let response;
    try {
      response = await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        response = json({ error: error.message }, error.status);
      } else {
        console.error(JSON.stringify({ message: 'falha inesperada', error: String(error?.stack ?? error) }));
        response = json({ error: 'o servidor teve um problema, tente de novo' }, 500);
      }
    }
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  },
};
