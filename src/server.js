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
const googlePhotosScope = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const googlePhotosRedirectUri = process.env.GOOGLE_REDIRECT_URI ?? `http://localhost:${port}/api/google-photos/callback`;
const googleOAuthStates = new Map();
const googlePhotoConnections = new Map();

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
    sendJson(response, currentUser ? 200 : 401, currentUser ? { user: publicUser(currentUser) } : {
      error: 'Please log in.',
      setupRequired: state.users.length === 0,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(request);

    if (state.users.length === 0) {
      createFirstUser(body, response);
      return;
    }

    const username = String(body.username ?? '').trim();
    const user = state.users.find((candidate) => {
      const loginName = candidate.username ?? candidate.name;
      return loginName.toLowerCase() === username.toLowerCase();
    });

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

  if (request.method === 'GET' && pathname === '/api/google-photos/callback') {
    await completeGooglePhotosAuthorization(request, response);
    return;
  }

  if (!currentUser) {
    sendJson(response, 401, { error: 'Please log in.' });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/google-photos/start') {
    if (!currentUser.isAdmin) {
      sendJson(response, 403, { error: 'Only administrators can import photos.' });
      return;
    }

    const sessionId = getCookies(request).family_session;
    if (!sessionId || !googlePhotosConfigured()) {
      sendJson(response, 503, { error: 'Google Photos import has not been configured.' });
      return;
    }

    const connection = googlePhotoConnections.get(sessionId);
    if (connection?.accessToken && connection.expiresAt > Date.now()) {
      const picker = await createGooglePickerSession(connection.accessToken);
      connection.pickerSessionId = picker.id;
      sendJson(response, 200, { pickerUri: picker.pickerUri });
      return;
    }

    const stateId = randomBytes(32).toString('hex');
    googleOAuthStates.set(stateId, { sessionId, expiresAt: Date.now() + 10 * 60 * 1000 });
    const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizationUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    authorizationUrl.searchParams.set('redirect_uri', googlePhotosRedirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', googlePhotosScope);
    authorizationUrl.searchParams.set('state', stateId);
    authorizationUrl.searchParams.set('access_type', 'online');
    authorizationUrl.searchParams.set('prompt', 'consent');
    sendJson(response, 200, { authorizationUrl: authorizationUrl.toString() });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/google-photos/status') {
    if (!currentUser.isAdmin) {
      sendJson(response, 403, { error: 'Only administrators can import photos.' });
      return;
    }

    const connection = googlePhotoConnections.get(getCookies(request).family_session);
    if (!connection?.pickerSessionId) {
      sendJson(response, 200, { ready: false });
      return;
    }

    const picker = await googlePhotosRequest(`/v1/sessions/${connection.pickerSessionId}`, connection.accessToken);
    if (!picker.mediaItemsSet) {
      sendJson(response, 200, { ready: false });
      return;
    }

    const mediaItems = await listGooglePickerMediaItems(connection);
    sendJson(response, 200, { ready: true, count: mediaItems.length });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/google-photos/import') {
    if (!currentUser.isAdmin) {
      sendJson(response, 403, { error: 'Only administrators can import photos.' });
      return;
    }

    const connection = googlePhotoConnections.get(getCookies(request).family_session);
    if (!connection?.pickerSessionId) {
      sendJson(response, 400, { error: 'Choose photos from Google Photos first.' });
      return;
    }

    const mediaItems = await listGooglePickerMediaItems(connection);
    let imported = 0;
    for (const mediaItem of mediaItems) {
      const mediaFile = mediaItem.mediaFile;
      if (!mediaFile?.baseUrl || !mediaFile.mimeType?.startsWith('image/')) {
        continue;
      }

      const imageResponse = await fetch(`${mediaFile.baseUrl}=w2048-h2048`);
      if (!imageResponse.ok) {
        continue;
      }

      const imageData = Buffer.from(await imageResponse.arrayBuffer()).toString('base64');
      state = addPhoto(state, {
        title: mediaFile.filename ?? 'Google Photo',
        description: '',
        imageData: `data:${mediaFile.mimeType};base64,${imageData}`,
        uploadedBy: currentUser.name,
      });
      imported += 1;
    }
    connection.pickerSessionId = null;
    saveData();
    sendJson(response, 201, { imported });
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
    const account = accountDetails(body);
    const password = String(body.password ?? '');

    if (!account || password.length < 8) {
      sendJson(response, 400, { error: 'Enter first name, last name, username, and a password with at least 8 characters.' });
      return;
    }

    if (state.users.some((user) => (user.username ?? user.name).toLowerCase() === account.username.toLowerCase())) {
      sendJson(response, 409, { error: 'That username is already in use.' });
      return;
    }

    state = {
      ...addUser(state, {
        ...account,
        isAdmin: false,
        ...hashPassword(password),
      }),
      currentUserId: currentUser.id,
    };
    saveData();
    sendJson(response, 201, { users: state.users.map(publicUser) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/photos') {
    if (!currentUser.isAdmin) {
      sendJson(response, 403, { error: 'Only administrators can upload photos.' });
      return;
    }

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

    if (!title || !isValidDate(date)) {
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
  const account = accountDetails(body);
  const password = String(body.password ?? '');

  if (!account || password.length < 8) {
    sendJson(response, 400, { error: 'Enter first name, last name, username, and a password with at least 8 characters.' });
    return;
  }

  state = addUser(state, {
    ...account,
    isAdmin: true,
    ...hashPassword(password),
  }, { autoSignIn: true });
  saveData();

  const user = state.users.find((candidate) => candidate.username === account.username);
  createSession(response, user);
  sendJson(response, 201, { user: publicUser(user) });
}

function accountDetails(body) {
  const firstName = String(body.firstName ?? '').trim();
  const lastName = String(body.lastName ?? '').trim();
  const username = String(body.username ?? '').trim();

  if (!firstName || !lastName || !username) {
    return null;
  }

  return { firstName, lastName, username, name: `${firstName} ${lastName}` };
}

async function completeGooglePhotosAuthorization(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const authorization = googleOAuthStates.get(url.searchParams.get('state'));
  googleOAuthStates.delete(url.searchParams.get('state'));

  if (!authorization || authorization.expiresAt < Date.now() || url.searchParams.has('error')) {
    sendGooglePhotosCallback(response, 'Google Photos authorization was cancelled or expired.');
    return;
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') ?? '',
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googlePhotosRedirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok || !tokens.access_token) {
    sendGooglePhotosCallback(response, 'Google Photos authorization failed.');
    return;
  }

  const picker = await createGooglePickerSession(tokens.access_token);
  googlePhotoConnections.set(authorization.sessionId, {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (Number(tokens.expires_in ?? 3600) * 1000),
    pickerSessionId: picker.id,
  });
  response.writeHead(302, { Location: `${picker.pickerUri}/autoclose` });
  response.end();
}

function sendGooglePhotosCallback(response, message) {
  response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>Google Photos</title><p>${message}</p>`);
}

function googlePhotosConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function createGooglePickerSession(accessToken) {
  return googlePhotosRequest('/v1/sessions', accessToken, { method: 'POST', body: '{}' });
}

async function listGooglePickerMediaItems(connection) {
  const mediaItems = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ sessionId: connection.pickerSessionId, pageSize: '100' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await googlePhotosRequest(`/v1/mediaItems?${query}`, connection.accessToken);
    mediaItems.push(...(page.mediaItems ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return mediaItems;
}

async function googlePhotosRequest(path, accessToken, options = {}) {
  const response = await fetch(`https://photospicker.googleapis.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message ?? 'Google Photos request failed.');
  }
  return payload;
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

function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }

  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
    isAdmin: user.isAdmin === true,
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

      body += chunk.toString('utf8');
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
