import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  enableNonRepudiationChecks,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import { CAMPUSES, DEFAULT_CAMPUS_ID, getCampus } from '../campuses.mjs';
import { normalizeEmail } from './accounts.mjs';

const GOOGLE_ISSUER = new URL('https://accounts.google.com');
const CAMPUS_CALLBACK = '/api/auth/campus/callback';
const FLOW_SECONDS = 10 * 60;
const MAX_FLOWS = 2048;
const invalidFlow = '登入連結已失效，請重新開始 Google 登入。';
const changedAccount = '登入帳號已變更，請重新開始 Google 登入。';

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function verifiedGoogleAccount(claims) {
  const subject = claims?.sub;
  const email = normalizeEmail(claims?.email);
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 255 || /[^\x21-\x7e]/.test(subject)
    || claims?.email_verified !== true || !email) {
    fail(403, '請使用已驗證的 Google 帳號登入。');
  }
  return { subject, email };
}

export function schoolIdentityFromClaims(claims) {
  const { subject, email } = verifiedGoogleAccount(claims);
  const hostedDomain = typeof claims?.hd === 'string' ? claims.hd.toLowerCase() : '';
  const [local, domain] = email.split('@');
  const campus = CAMPUSES.find(entry => entry.googleDomain === domain && entry.hostedDomains.includes(hostedDomain));
  if (!campus || (campus.id === DEFAULT_CAMPUS_ID && !/^s\d+$/.test(local))) {
    fail(403, '請使用支援學校的 Google 校園帳號登入。');
  }
  return { subject, email, campusId: campus.id };
}

function personalIdentityFromClaims(claims) {
  const { subject, email } = verifiedGoogleAccount(claims);
  if (!email.endsWith('@gmail.com') || claims.hd !== undefined) fail(403, '請選擇一般 Gmail 帳號登入。');
  return { subject, email, campusId: null };
}

export function createCampusAuth({ origin, clientId, clientSecret, secureCookies = true }) {
  const callback = new URL(CAMPUS_CALLBACK, origin);
  const cookieName = secureCookies ? '__Host-studymate-campus-flow' : 'studymate-campus-flow';
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;
  const flows = new Map();
  let configuration;

  function googleConfiguration() {
    configuration ??= discovery(GOOGLE_ISSUER, clientId, clientSecret, undefined, {
      execute: [enableNonRepudiationChecks],
      timeout: 10,
    }).catch(() => {
      configuration = undefined;
      fail(503, '暫時無法連線至 Google 登入服務，請稍後再試。');
    });
    return configuration;
  }

  function readFlowCookie(request) {
    const cookies = request.headers.cookie;
    if (typeof cookies !== 'string') return '';
    const prefix = `${cookieName}=`;
    const cookie = cookies.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    return cookie?.slice(prefix.length) || '';
  }

  function writeFlowCookie(response, value, maxAge = FLOW_SECONDS) {
    response.appendHeader('Set-Cookie', `${cookieName}=${value}; Max-Age=${maxAge}; ${cookieAttributes}`);
  }

  async function start(request, response, account) {
    const url = new URL(request.url, origin);
    const intent = url.searchParams.get('intent') || 'signin';
    const selectedId = url.searchParams.get('campus');
    const automatic = selectedId === 'any';
    const personal = selectedId === 'personal';
    const campus = getCampus(selectedId);
    if (selectedId !== null && !campus && !personal && !automatic) fail(400, '請選擇支援的 Google 帳號類型。');
    if (!['signin', 'link', 'delete'].includes(intent)) fail(400, invalidFlow);
    if (intent === 'link') {
      const site = request.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') fail(403, '請從 StudyMate 的帳號頁面完成 Google 帳號連結。');
      if (account?.role !== 'student' || account.id !== url.searchParams.get('account')) fail(409, changedAccount);
    } else if (intent === 'signin' && account) {
      fail(409, '若要切換帳號，請先登出 StudyMate。');
    } else if (intent === 'delete' && account && (account.role !== 'student' || !account.googleEmail)) {
      fail(409, '若要驗證其他 Google 帳號，請先登出 StudyMate。');
    }

    const config = await googleConfiguration();
    const state = randomState();
    const nonce = randomNonce();
    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    const redirect = buildAuthorizationUrl(config, {
      redirect_uri: callback.href,
      scope: 'openid email',
      ...(personal || automatic ? {} : { hd: (campus ?? getCampus(DEFAULT_CAMPUS_ID)).googleDomain }),
      prompt: 'select_account',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const now = Date.now();
    for (const [key, flow] of flows) {
      if (flow.expiresAt > now) break;
      flows.delete(key);
    }
    flows.delete(readFlowCookie(request));
    if (flows.size >= MAX_FLOWS) fail(429, 'Google 登入目前較忙，請稍後再試。');
    flows.set(state, {
      intent, selectedId, accountId: account?.id ?? null, nonce, verifier, expiresAt: now + FLOW_SECONDS * 1000,
    });
    writeFlowCookie(response, state);
    return redirect;
  }

  async function complete(request, response, account) {
    const currentUrl = new URL(callback);
    currentUrl.search = new URL(request.url, origin).search;
    const [state, extraState] = currentUrl.searchParams.getAll('state');
    if (!state || extraState !== undefined || readFlowCookie(request) !== state) fail(400, invalidFlow);
    const flow = flows.get(state);
    flows.delete(state);
    writeFlowCookie(response, '', 0);
    if (!flow || flow.expiresAt <= Date.now()) fail(400, invalidFlow);
    try {
      if ((account?.id ?? null) !== flow.accountId || (flow.intent === 'link' && account?.role !== 'student')) {
        fail(409, changedAccount);
      }
      if (currentUrl.searchParams.has('error')) fail(400, 'Google 登入未完成，請重試或選用另一個帳號。');

      const config = await googleConfiguration();
      let claims;
      try {
        const tokens = await authorizationCodeGrant(config, currentUrl, {
          pkceCodeVerifier: flow.verifier,
          expectedState: state,
          expectedNonce: flow.nonce,
        });
        claims = tokens.claims();
      } catch {
        fail(401, '無法驗證 Google 帳號登入，請重新開始。');
      }
      const personal = flow.selectedId === 'personal' || (flow.selectedId === 'any' && claims?.hd === undefined);
      const identity = personal ? personalIdentityFromClaims(claims) : schoolIdentityFromClaims(claims);
      return { intent: flow.intent, accountId: flow.accountId, identity };
    } catch (error) {
      if (flow.intent === 'delete') error.deletionFlow = true;
      throw error;
    }
  }

  function discardAccountFlows(accountId) {
    for (const [state, flow] of flows) {
      if (flow.accountId === accountId) flows.delete(state);
    }
  }

  return { start, complete, discardAccountFlows };
}
