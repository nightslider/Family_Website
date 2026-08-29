import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addComment, addPhoto, addTimelineItem, addUser, normalizeState, toggleReaction } from './store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDirectory = resolve(__dirname, '..');
const dataFile = process.env.FAMILY_DATA_FILE
  ? resolve(process.env.FAMILY_DATA_FILE)
  : join(rootDirectory, 'data', 'family-data.json');
const dataDirectory = resolve(dataFile, '..');
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
// Sessions are intentionally in memory; restarting the server signs everyone out.
const sessions = new Map();
const reactions = ['❤️', '😂', '🎉', '🙏', '😍'];
const publicFiles = new Set(['/index.html', '/src/app.js', '/src/store.js', '/src/styles.css']);
const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';

let state = loadData();

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  try {
    if (request.url?.startsWith('/api/')) {
      await handleApi(request, response);
      return;
    }

    serveStatic(request, response);
  } catch (error) {
    sendJson(response, 500, { error: 'The family website had a server error.' });
  }
});

server.listen(port, () => {
  console.log(`Family website running at http://localhost:${port}`);
});

function loadData() {
  if (!existsSync(dataFile)) {
    return normalizeState();
  }

  try {
    return normalizeState(JSON.parse(readFileSync(dataFile, 'utf8')));
  } catch {
    return normalizeState();
  }
}

function saveData() {
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(dataFile, JSON.stringify(state, null, 2));
}

async function handleApi(request, response) {
  const { pathname } = new URL(request.url, 'http://localhost');
  const currentUser = getSessionUser(request);

  if (request.method === 'GET' && pathname === '/api/me') {
    sendJson(response, currentUser ? 200 : 401, currentUser ? { user: publicUser(currentUser) } : { error: 'Please log in.' });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(request);

    if (state.users.length === 0) {
      createFirstUser(body, response);
      return;
    }

    const user = state.users.find((candidate) => candidate.name.toLowerCase() === String(body.name ?? '').trim().toLowerCase());

    if (!user || !verifyPassword(String(body.password ?? ''), user)) {
      sendJson(response, 401, { error: 'That login did not match a family account.' });
      return;
    }

    createSession(response, user);
    sendJson(response, 200, { user: publicUser(user) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/logout') {
    clearSession(request, response);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (!currentUser) {
    sendJson(response, 401, { error: 'Please log in.' });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/data') {
    sendJson(response, 200, {
      users: state.users.map(publicUser),
      photos: state.photos,
      events: state.events,
      milestones: state.milestones,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/users') {
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    const password = String(body.password ?? '');

    if (!name || password.length < 8) {
      sendJson(response, 400, { error: 'Enter a name and a password with at least 8 characters.' });
      return;
    }

    if (state.users.some((user) => user.name.toLowerCase() === name.toLowerCase())) {
      sendJson(response, 409, { error: 'That family member already has a login.' });
      return;
    }

    state = {
      ...addUser(state, {
        name,
        ...hashPassword(password),
      }),
      currentUserId: currentUser.id,
    };
    saveData();
    sendJson(response, 201, { users: state.users.map(publicUser) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/photos') {
    const body = await readJson(request, 8 * 1024 * 1024);
    const imageData = String(body.imageData ?? '');

    if (!String(body.title ?? '').trim() || !imageData.startsWith('data:image/')) {
      sendJson(response, 400, { error: 'Add a title and choose an image file.' });
      return;
    }

    state = addPhoto(state, {
      title: String(body.title),
      description: String(body.description ?? ''),
      imageData,
      uploadedBy: currentUser.name,
    });
    saveData();
    sendJson(response, 201, { photo: state.photos[0] });
    return;
  }

  const photoCommentMatch = pathname.match(/^\/api\/photos\/([^/]+)\/comments$/);
  if (request.method === 'POST' && photoCommentMatch) {
    const photoId = decodeURIComponent(photoCommentMatch[1]);
    const body = await readJson(request);
    const text = String(body.text ?? '').trim();

    if (!text || !state.photos.some((photo) => photo.id === photoId)) {
      sendJson(response, 400, { error: 'Choose a photo and enter a comment.' });
      return;
    }

    state = addComment(state, photoId, { author: currentUser.name, text });
    saveData();
    sendJson(response, 201, { ok: true });
    return;
  }

  const photoReactionMatch = pathname.match(/^\/api\/photos\/([^/]+)\/reactions$/);
  if (request.method === 'POST' && photoReactionMatch) {
    const photoId = decodeURIComponent(photoReactionMatch[1]);
    const body = await readJson(request);
    const emoji = String(body.emoji ?? '');

    if (!reactions.includes(emoji) || !state.photos.some((photo) => photo.id === photoId)) {
      sendJson(response, 400, { error: 'Choose a photo and reaction.' });
      return;
    }

    state = toggleReaction(state, photoId, emoji, currentUser.id);
    saveData();
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'POST' && (pathname === '/api/events' || pathname === '/api/milestones')) {
    const body = await readJson(request);
    const title = String(body.title ?? '').trim();
    const date = String(body.date ?? '');

    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(response, 400, { error: 'Enter a title and date.' });
      return;
    }

    const collectionName = pathname.slice('/api/'.length);
    state = addTimelineItem(state, collectionName, {
      title,
      date,
      description: String(body.description ?? ''),
      createdBy: currentUser.name,
    });
    saveData();
    sendJson(response, 201, { ok: true });
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
}

function createFirstUser(body, response) {
  const name = String(body.name ?? '').trim();
  const password = String(body.password ?? '');

  if (!name || password.length < 8) {
    sendJson(response, 400, { error: 'Create the first family login with a name and password of at least 8 characters.' });
    return;
  }

  state = addUser(state, {
    name,
    ...hashPassword(password),
  }, { autoSignIn: true });
  saveData();

  const user = state.users.find((candidate) => candidate.id === state.currentUserId);
  createSession(response, user);
  sendJson(response, 201, { user: publicUser(user) });
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return {
    salt,
    passwordHash: pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex'),
  };
}

function verifyPassword(password, user) {
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = pbkdf2Sync(password, user.salt, 310000, 32, 'sha256');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createSession(response, user) {
  const sessionId = randomBytes(32).toString('hex');
  sessions.set(sessionId, user.id);
  response.setHeader('Set-Cookie', `family_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie}`);
}

function clearSession(request, response) {
  const sessionId = getCookies(request).family_session;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  response.setHeader('Set-Cookie', `family_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
}

function getSessionUser(request) {
  const sessionId = getCookies(request).family_session;
  const userId = sessionId ? sessions.get(sessionId) : null;
  return state.users.find((user) => user.id === userId) ?? null;
}

function getCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie ?? '')
      .split(';')
      .filter(Boolean)
      .map((cookie) => {
        const [name, ...value] = cookie.trim().split('=');
        return [name, decodeURIComponent(value.join('='))];
      }),
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
  };
}

function readJson(request, maxBytes = 1024 * 1024) {
  return new Promise((resolveRequest, rejectRequest) => {
    let body = '';
    let bytesRead = 0;
    let settled = false;

    const rejectOnce = (error) => {
      if (!settled) {
        settled = true;
        rejectRequest(error);
      }
    };

    request.on('data', (chunk) => {
      bytesRead += Buffer.byteLength(chunk);
      if (bytesRead > maxBytes) {
        request.destroy();
        rejectOnce(new Error('Request body is too large.'));
        return;
      }

      body += chunk;
    });
    request.on('end', () => {
      if (settled) {
        return;
      }

      try {
        const parsedBody = body ? JSON.parse(body) : {};
        settled = true;
        resolveRequest(parsedBody);
      } catch {
        rejectOnce(new Error('Invalid JSON.'));
      }
    });
    request.on('error', rejectOnce);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function serveStatic(request, response) {
  const { pathname } = new URL(request.url, 'http://localhost');
  const publicPath = pathname === '/' ? '/index.html' : pathname;

  if (!publicFiles.has(publicPath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const relativePath = publicPath.slice(1);
  const filePath = normalize(join(rootDirectory, relativePath));

  if (!filePath.startsWith(rootDirectory) || !existsSync(filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
}
