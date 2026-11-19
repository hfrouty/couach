import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createAccounts, normalizeEmail } from './accounts.mjs';
import { createRecords } from './records.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const mime = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};
const publicFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/admin', 'admin.html'],
  ['/admin/', 'admin.html'],
  ...[
    'app.mjs', 'admin.mjs', 'matching.mjs', 'sample-data.mjs', 'study-tools.mjs', 'icons.mjs',
    'styles.css', 'tools.css', 'account.css', 'admin.css',
    'assets/icon.svg', 'assets/library-study.webp',
  ].map(name => [`/${name}`, name]),
]);
const dataLimit = 16 * 1024;
const authWindow = 60_000;
const authLimits = {
  login: { ip: 60, account: 8 },
  register: { ip: 20, account: 5 },
  setup: { ip: 8 },
};

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function throttle(seconds) {
  throw Object.assign(new Error(`操作太頻繁，請在 ${seconds} 秒後再試。`), {
    status: 429, retryAfter: seconds,
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    fail(415, '請以 JSON 送出資料。');
  }
  if (Number(request.headers['content-length']) > dataLimit) {
    fail(413, '送出的資料過長。');
  }
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', chunk => {
      length += chunk.length;
      if (length <= dataLimit) chunks.push(chunk);
      else reject(Object.assign(new Error('送出的資料過長。'), { status: 413 }));
    });
    request.on('error', reject);
    request.on('end', () => {
      if (length > dataLimit) return;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
        resolveBody(result);
      } catch {
        reject(Object.assign(new Error('送出的 JSON 格式不正確。'), { status: 400 }));
      }
    });
  });
}

function applyHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
}

function requireSameOrigin(request, railway) {
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site') fail(403, '請從 StudyMate 送出操作。');
  if (!origin) {
    if (railway) fail(403, '找不到操作來源。');
    return;
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail(403, '無法驗證操作來源。');
  }
  const protocol = railway ? 'https:' : 'http:';
  if (url.protocol !== protocol || url.host !== request.headers.host) {
    fail(403, '請從 StudyMate 送出操作。');
  }
}

function authLimiter(railway) {
  const attempts = new Map();
  let clearAt = 0;
  return (request, action, data) => {
    const now = Date.now();
    if (now >= clearAt) {
      attempts.clear();
      clearAt = now + authWindow;
    }
    const realIp = request.headers['x-real-ip'];
    const ip = railway && typeof realIp === 'string' && isIP(realIp)
      ? realIp
      : request.socket.remoteAddress || 'unknown';
    const limits = authLimits[action];
    const ipKey = `${action}:${ip}`;
    const keys = [[ipKey, limits.ip]];
    const email = limits.account && normalizeEmail(data.email);
    if (email) keys.push([`${ipKey}/${email}`, limits.account]);

    const newKeys = keys.filter(([key]) => !attempts.has(key)).length;
    if (attempts.size + newKeys > 20_000 || keys.some(([key, limit]) => (attempts.get(key) ?? 0) >= limit)) {
      throttle(Math.ceil((clearAt - now) / 1000));
    }
    for (const [key] of keys) attempts.set(key, (attempts.get(key) ?? 0) + 1);
  };
}

export function createStudyServer({
  databaseFile,
  publicHttps = false,
  adminSetupToken = '',
  temporarySetup,
}) {
  if (databaseFile !== ':memory:') mkdirSync(dirname(databaseFile), { recursive: true });
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL');
  const accounts = createAccounts(db, { secureCookies: publicHttps, adminSetupToken, temporarySetup });
  const records = createRecords(db);
  const throttleAuth = authLimiter(publicHttps);
  const files = new Map([...publicFiles].map(([route, file]) => [
    route, { body: readFileSync(join(root, file)), type: mime[file.split('.').at(-1)] },
  ]));
  let authInFlight = 0;

  async function handleApi(request, response, method, route) {
    if (method !== 'GET') requireSameOrigin(request, publicHttps);
    const account = await accounts.current(request);
    if (method === 'GET' && route === '/api/account') return { account, adminSetup: accounts.setupAvailable() };
    if (method === 'POST' && ['/api/auth/register', '/api/auth/login', '/api/auth/setup'].includes(route)) {
      const action = route.split('/').at(-1);
      const data = await readJson(request);
      if (authInFlight >= 8) throttle(3);
      throttleAuth(request, action, data);
      authInFlight += 1;
      try {
        return { account: await accounts[action](data, response) };
      } finally {
        authInFlight -= 1;
      }
    }
    if (method === 'POST' && route === '/api/auth/logout') {
      await accounts.logout(request, response);
      return { account: null };
    }
    if (!account) fail(401, '請先登入 StudyMate。');
    if (method === 'PATCH' && route === '/api/profile') {
      return { account: await accounts.updateProfile(account, await readJson(request)) };
    }
    if (route.startsWith('/api/admin/')) {
      if (account.role !== 'admin') fail(403, '此頁面僅限管理員使用。');
      const resolveReport = route.match(/^\/api\/admin\/reports\/([a-z0-9-]+)\/resolve$/);
      if (method === 'POST' && resolveReport) records.resolveReport(resolveReport[1]);
      else if (method !== 'GET' || route !== '/api/admin/overview') fail(404, '找不到這個功能。');
      return { accounts: await accounts.listAccounts(), ...records.moderation() };
    }
    if (method === 'GET' && route === '/api/study') return records.state(account);
    if (method !== 'POST') fail(404, '找不到這個功能。');
    if (route === '/api/study/sessions') {
      records.publish(account, await readJson(request));
    } else if (route === '/api/study/focus') {
      records.addFocus(account, await readJson(request));
    } else {
      const session = route.match(/^\/api\/study\/sessions\/([a-z0-9-]+)\/(close|join|report|block)$/);
      const reservation = route.match(/^\/api\/study\/reservations\/([a-z0-9-]+)$/);
      if (session) {
        const [, id, action] = session;
        if (action === 'close') records.close(account, id);
        if (action === 'join') records.requestJoin(account, id);
        if (action === 'report') records.report(account, id, (await readJson(request)).reason);
        if (action === 'block') records.block(account, id);
      } else if (reservation) {
        records.setReservationStatus(account, reservation[1], (await readJson(request)).status);
      } else {
        fail(404, '找不到這個功能。');
      }
    }
    return records.state(account);
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    applyHeaders(response);
    try {
      const method = request.method;
      const route = new URL(request.url, 'http://local').pathname;
      if (method === 'GET' && route === '/health') {
        if (temporarySetup) response.setHeader('X-StudyMate-Initial-Setup', 'temporary');
        return sendJson(response, 200, { ok: true });
      }
      if (route.startsWith('/api/')) {
        const result = await handleApi(request, response, method, route);
        return sendJson(response, 200, result);
      }
      const asset = files.get(route);
      if (asset && (method === 'GET' || method === 'HEAD')) {
        response.writeHead(200, {
          'Content-Type': asset.type,
          'Content-Length': asset.body.length,
          'Cache-Control': 'no-cache',
        });
        return response.end(method === 'HEAD' ? undefined : asset.body);
      }
      fail(404, '找不到這個頁面。');
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500 && status !== 503) console.error(error);
      if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
      return sendJson(response, status, { error: status === 500 ? '暫時無法處理，請稍後再試。' : error.message });
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_ID);
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (onRailway && (!volume || !isAbsolute(volume))) {
    throw new Error('Attach a Railway volume before starting StudyMate. Mount it at /app/data.');
  }
  const databaseFile = volume ? join(volume, 'studymate.sqlite') : join(root, 'data', 'studymate.sqlite');
  // Short-lived verification for the first administrator of this Railway service.
  const temporarySetup = process.env.RAILWAY_SERVICE_ID === 'fe86563b-8fec-440e-92a4-45789f3b5a1b'
    && process.env.RAILWAY_ENVIRONMENT_ID === '4094ec84-1614-4c0f-973d-f71619bc49ca'
    ? { digest: '5931a5c81e84588ea283c3c8512f9008c573d7a7455b5a149bc8e53278b378a6', expiresAt: 1795109000775 }
    : undefined;
  const server = createStudyServer({
    databaseFile,
    publicHttps: onRailway,
    adminSetupToken: process.env.ADMIN_SETUP_TOKEN ?? '',
    temporarySetup,
  });
  const port = Number(process.env.PORT ?? 8000);
  server.listen(port, onRailway ? '0.0.0.0' : '127.0.0.1', () => console.log(`StudyMate is listening on ${port}`));
}
