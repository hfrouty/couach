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

const GOOGLE_ISSUER = new URL('https://accounts.google.com');
const CAMPUS_CALLBACK = '/api/auth/campus/callback';
const STUDENT_DOMAIN = 'mail1.ncnu.edu.tw';
const NCNU_HOSTED_DOMAINS = new Set(['ncnu.edu.tw', STUDENT_DOMAIN]);
const FLOW_SECONDS = 10 * 60;
const MAX_FLOWS = 2048;
const invalidFlow = '登入連結已失效，請重新開始學校帳號登入。';
const changedAccount = '登入帳號已變更，請重新開始學校帳號登入。';

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function schoolIdentityFromClaims(claims) {
  const subject = claims?.sub;
  const email = typeof claims?.email === 'string' ? claims.email.toLowerCase() : '';
  const hostedDomain = typeof claims?.hd === 'string' ? claims.hd.toLowerCase() : '';
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 255 || /[^\x21-\x7e]/.test(subject)
    || claims.email_verified !== true || !NCNU_HOSTED_DOMAINS.has(hostedDomain)
    || email.length > 254 || !/^s\d+@mail1\.ncnu\.edu\.tw$/.test(email)) {
    fail(403, '請使用國立暨南國際大學的學生 Google 校園帳號登入。');
  }
  return { subject, email, campusId: 'ncnu' };
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
      fail(503, '暫時無法連線至學校帳號登入服務，請稍後再試。');
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
    if (intent !== 'signin' && intent !== 'link') fail(400, invalidFlow);
    if (intent === 'link') {
      const site = request.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') fail(403, '請從 StudyMate 的帳號頁面完成學校帳號連結。');
      if (account?.role !== 'student' || account.id !== url.searchParams.get('account')) fail(409, changedAccount);
    } else if (account) {
      fail(409, '若要切換帳號，請先登出 StudyMate。');
    }

    const config = await googleConfiguration();
    const state = randomState();
    const nonce = randomNonce();
    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    const redirect = buildAuthorizationUrl(config, {
      redirect_uri: callback.href,
      scope: 'openid email',
      hd: STUDENT_DOMAIN,
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
    if (flows.size >= MAX_FLOWS) fail(429, '學校帳號登入目前較忙，請稍後再試。');
    flows.set(state, { intent, accountId: account?.id ?? null, nonce, verifier, expiresAt: now + FLOW_SECONDS * 1000 });
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
    if ((account?.id ?? null) !== flow.accountId || (flow.intent === 'link' && account?.role !== 'student')) {
      fail(409, changedAccount);
    }
    if (currentUrl.searchParams.has('error')) fail(400, '學校帳號登入未完成，請重試或選用另一個學校帳號。');

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
      fail(401, '無法驗證學校帳號登入，請重新開始。');
    }
    return { intent: flow.intent, accountId: flow.accountId, identity: schoolIdentityFromClaims(claims) };
  }

  return { start, complete };
}
