import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DEPARTMENTS, REGIONS, STYLES, SUBJECTS } from '../sample-data.mjs';

const deriveKey = promisify(scrypt);
const keySize = 64;
const passwordCost = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const dummySalt = randomBytes(16);
const dummyKey = randomBytes(keySize);
const sessionLifetime = 7 * 24 * 60 * 60;
const profileOptions = { department: DEPARTMENTS, region: REGIONS, subject: SUBJECTS, style: STYLES };
const publicFields = 'id, email, name, department, region, subject, style, role, created_at AS createdAt';

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

export function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const normalized = value.trim().toLowerCase();
  const [local, domain, extra] = normalized.split('@');
  const localPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (extra !== undefined || !local || local.length > 64 || !localPattern.test(local) || !domain?.includes('.')) return null;
  return domain.split('.').every(label => domainLabel.test(label)) ? normalized : null;
}

function validPassword(value, minimum = 8) {
  if (typeof value !== 'string' || value.length > 256 || !value.isWellFormed()) return false;
  const length = [...value].length;
  return length >= minimum && length <= 128;
}

function validatedProfile(data, current = {}) {
  const name = data?.name === undefined ? current.name : data.name;
  if (typeof name !== 'string' || !name.isWellFormed() || !name.trim() || [...name.trim()].length > 40 || /\p{Cc}/u.test(name)) {
    fail(400, '請輸入 1 至 40 個字元的暱稱。');
  }

  const profile = { name: name.trim() };
  for (const [key, options] of Object.entries(profileOptions)) {
    const value = data[key] === undefined ? (current[key] ?? options[0]) : data[key];
    if (!options.includes(value)) fail(400, '請從清單選擇有效的讀書偏好。');
    profile[key] = value;
  }
  return profile;
}

export function createAccounts(db, { secureCookies = true, adminSetupToken, temporarySetup } = {}) {
  const cookieName = secureCookies ? '__Host-studymate_session' : 'studymate_session';
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;
  const setupHash = typeof adminSetupToken === 'string' && adminSetupToken.length >= 32 ? digest(adminSetupToken) : null;

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      region TEXT NOT NULL,
      subject TEXT NOT NULL,
      style TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'admin')),
      password_salt BLOB NOT NULL,
      password_hash BLOB NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_single_admin ON accounts(role) WHERE role = 'admin';

    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);
  `);

  const insertAccount = db.prepare(`
    INSERT INTO accounts (id, email, name, department, region, subject, style, role, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
    RETURNING ${publicFields}
  `);
  const findCredentials = db.prepare('SELECT id, password_salt, password_hash FROM accounts WHERE email = ?');
  const findAccount = db.prepare(`SELECT ${publicFields} FROM accounts WHERE id = ?`);
  const selectAccounts = db.prepare(`SELECT ${publicFields} FROM accounts ORDER BY created_at DESC, id DESC`);
  const findAdmin = db.prepare("SELECT id FROM accounts WHERE role = 'admin'");
  const saveProfile = db.prepare(`
    UPDATE accounts SET name = ?, department = ?, region = ?, subject = ?, style = ? WHERE id = ?
    RETURNING ${publicFields}
  `);
  const insertSession = db.prepare('INSERT INTO account_sessions(token_hash, account_id, expires_at) VALUES (?, ?, ?)');
  const findActiveSession = db.prepare('SELECT account_id FROM account_sessions WHERE token_hash = ? AND expires_at > ?');
  const deleteSession = db.prepare('DELETE FROM account_sessions WHERE token_hash = ?');
  const expireSessions = db.prepare('DELETE FROM account_sessions WHERE expires_at <= ?');

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function adminConfigured() {
    return Boolean(findAdmin.get());
  }

  function effectiveSetupHash() {
    if (setupHash) return setupHash;
    if (!temporarySetup || temporarySetup.expiresAt <= Date.now()) return null;
    return Buffer.from(temporarySetup.digest, 'hex');
  }

  function setupAvailable() {
    return Boolean(effectiveSetupHash()) && !adminConfigured();
  }

  function grantSession(accountId) {
    const now = Date.now();
    const token = randomBytes(32).toString('base64url');
    expireSessions.run(now);
    insertSession.run(digest(token).toString('hex'), accountId, now + sessionLifetime * 1000);
    return token;
  }

  function sendCookie(res, token, maxAge = sessionLifetime) {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Max-Age=${maxAge}; ${cookieAttributes}`);
  }

  function readSessionHash(req) {
    const header = req.headers.cookie;
    if (typeof header !== 'string') return null;

    const name = `${cookieName}=`;
    const cookie = header.split(';').map(value => value.trim()).find(value => value.startsWith(name));
    const token = cookie?.slice(name.length) ?? '';
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token).toString('hex') : null;
  }

  function current(req) {
    const hash = readSessionHash(req);
    const session = hash ? findActiveSession.get(hash, Date.now()) : null;
    return session ? (findAccount.get(session.account_id) ?? null) : null;
  }

  async function createAccount(data, res, role) {
    const email = normalizeEmail(data?.email);
    const minimum = role === 'admin' ? 12 : 8;
    if (!email) fail(400, '請輸入有效的電子信箱。');
    if (!validPassword(data.password, minimum)) fail(400, `密碼須為 ${minimum} 至 128 個字元。`);
    const { name, department, region, subject, style } = validatedProfile(data);
    const salt = randomBytes(16);
    const hash = await deriveKey(data.password, salt, keySize, passwordCost);
    const { account, token } = transaction(() => {
      if (role === 'admin' && adminConfigured()) fail(409, '管理員帳號已建立。');
      const created = insertAccount.get(randomUUID(), email, name, department, region, subject, style, role, salt, hash, new Date().toISOString());
      if (!created) fail(409, '這個電子信箱已經註冊。');
      return { account: created, token: grantSession(created.id) };
    });
    sendCookie(res, token);
    return account;
  }

  function register(data, res) {
    return createAccount(data, res, 'student');
  }

  async function login(data, res) {
    const email = normalizeEmail(data?.email);
    if (!email || !validPassword(data?.password)) fail(401, '電子信箱或密碼不正確。');
    const credentials = findCredentials.get(email);
    const actual = await deriveKey(data.password, credentials?.password_salt ?? dummySalt, keySize, passwordCost);
    const matches = timingSafeEqual(actual, credentials?.password_hash ?? dummyKey);
    if (!matches || !credentials) fail(401, '電子信箱或密碼不正確。');

    const account = findAccount.get(credentials.id);
    if (!account) fail(401, '電子信箱或密碼不正確。');
    const token = transaction(() => grantSession(account.id));
    sendCookie(res, token);
    return account;
  }

  function logout(req, res) {
    const hash = readSessionHash(req);
    if (hash) deleteSession.run(hash);
    sendCookie(res, '', 0);
  }

  function setup(data, res) {
    if (adminConfigured()) fail(409, '管理員帳號已建立。');
    const expectedHash = effectiveSetupHash();
    if (!expectedHash) fail(503, '管理員設定尚未開放。');

    const token = data?.setupToken;
    if (typeof token !== 'string' || token.length > 4096 || !timingSafeEqual(digest(token), expectedHash)) {
      fail(403, '管理員設定密鑰不正確。');
    }
    return createAccount(data, res, 'admin');
  }

  function updateProfile(account, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, '請輸入有效的讀書偏好。');
    const { name, department, region, subject, style } = validatedProfile(data, account);
    return saveProfile.get(name, department, region, subject, style, account.id);
  }

  function listAccounts() {
    return selectAccounts.all();
  }

  return { register, login, logout, current, setup, updateProfile, listAccounts, adminConfigured, setupAvailable };
}
