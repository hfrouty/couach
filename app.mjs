import { icon } from './icons.mjs';
import { isLive, scoreSession } from './matching.mjs';
import { SUBJECTS, STYLES, DEPARTMENTS, PLACES } from './sample-data.mjs';
import { createStudyTools } from './study-tools.mjs';
import {
  bindCampusMap, clearCampusWalkingRoute, locateCampusPosition, renderCampusMap, showCampusCafes, showCampusWalkingRoute,
  updateCampusMapSelection, viewCampusDestination, walkingDirectionsURL,
} from './campus-map.mjs';
import { getCampusPlaces } from './campus-places.mjs';
import { CAMPUSES, DEFAULT_CAMPUS_ID, campusRegionNames, getCampus } from './campuses.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toastNode = document.querySelector('#toast');
const minute = 60_000;
const timeZone = 'Asia/Taipei';
const dayFormat = new Intl.DateTimeFormat('zh-TW', { timeZone, month: 'numeric', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('zh-TW', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const onlineScopeNote = '線上共讀不限校園區域';
const matchPollInterval = 4_000;
const locationUploadInterval = 3_500;
const activeMatchStatuses = new Set(['searching', 'found', 'waiting']);

const initialFilters = { timing: 'all', subject: '', mode: '', region: '', style: '', department: '', cross: false, sort: 'score' };

let state = emptyState();
let filters = { ...initialFilters };
let explorePane = 'list';
let match = { status: 'idle' };
let matchRegion = '';
let matchMapView = '';
let matchPoll;
let matchClock;
let matchLocationExpiry;
let matchAutoShare = false;
let matchLocationRequested = false;
let matchLocationError = '';
let matchDeviceFix;
let matchLocationUpload;
let matchLocationUploadTimer;
let lastLocationUploadAt = 0;
let matchCheck = null;
let matchActing = false;
let matchRevision = 0;
let matchConnectionLost = false;
let cleanup = () => {};
let toastTimeout;
let view = activeView();
let authMode = 'login';
let campusLogin = false;
let legacyLogin = false;
let selectedCampusId = DEFAULT_CAMPUS_ID;
let loading = true;
let loadError = '';
let adminSetup = false;
let activeRequest = false;
let studyVersion = 0;
let focusSync = null;
const publishDrafts = new Map();
const navigation = [
  ['explore', 'compass', '找讀書夥伴'],
  ['match', 'bolt', '配對'],
  ['plans', 'calendar', '我的預約'],
  ['focus', 'timer', '專注計時'],
  ['places', 'pin', '讀書空間'],
];
let campusNotice = '';
const entryUrl = new URL(window.location.href);
const campusNotices = new Map([
  ['school', '請在 Google 選擇一般 Gmail 或支援學校的 Google 帳號。'],
  ['link', '這個信箱可能已有 StudyMate 帳號，請先用舊帳密登入，再連結 Google 帳號。'],
  ['account', 'Google 帳號未能連結，請確認目前登入的 StudyMate 帳號後重試。'],
  ['failed', 'Google 登入未完成，請重新開始。'],
  ['busy', 'Google 登入目前較忙，請稍後再試。'],
  ['unavailable', 'Google 登入目前未開放，請稍後再試。'],
]);
if (entryUrl.searchParams.has('campus')) {
  campusNotice = campusNotices.get(entryUrl.searchParams.get('campus')) ?? '';
  entryUrl.searchParams.delete('campus');
  history.replaceState(history.state, '', entryUrl);
}

function emptyState() {
  return { account: null, sessions: [], reservations: {}, incoming: [], focusLog: [], pendingFocus: [] };
}

async function api(path, { method = 'GET', data } = {}) {
  const accountId = state.account?.id;
  const scoped = path === '/study' || path.startsWith('/study/') || path === '/profile' || path === '/auth/logout';
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        ...(scoped && accountId ? { 'X-StudyMate-Account': accountId } : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(data ?? {}) }),
    });
  } catch {
    throw new Error('無法連線，請檢查網路後再試。');
  }
  const payload = await response.json().catch(() => null);
  if (response.ok) return payload;
  const message = typeof payload?.error === 'string' ? payload.error : '暫時無法完成操作，請稍後再試。';
  const accountChanged = scoped && response.status === 409 && payload?.code === 'ACCOUNT_CHANGED';
  if ((response.status === 401 || accountChanged) && accountId && state.account?.id === accountId) {
    resetAccount();
    if (accountChanged) loadError = message;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    render();
    if (accountChanged) app.querySelector('main').focus({ preventScroll: true });
    else toast('登入已過期，請重新登入。');
  }
  throw Object.assign(new Error(message), { code: accountChanged ? 'ACCOUNT_CHANGED' : undefined });
}

function timerKey(id) {
  return `studymate:focus:${id}`;
}

function restoreTimer(id) {
  try {
    const local = JSON.parse(localStorage.getItem(timerKey(id)));
    return { focus: local?.focus, pendingFocus: Array.isArray(local?.pendingFocus) ? local.pendingFocus : [] };
  } catch {
    return { pendingFocus: [] };
  }
}

function saveTimer() {
  if (!state.account) return;
  try {
    localStorage.setItem(timerKey(state.account.id), JSON.stringify({ focus: state.focus, pendingFocus: state.pendingFocus }));
  } catch {
    // The running timer remains usable when browser storage is restricted.
  }
}

function bindAccount(account) {
  resetMatch();
  state = { ...emptyState(), account, ...restoreTimer(account.id) };
  selectedCampusId = account.campusId ?? rememberedCampus(account.id);
  filters = { ...initialFilters };
  explorePane = 'list';
  loadError = '';
}

function resetAccount() {
  resetMatch();
  state = emptyState();
  authMode = 'login';
  legacyLogin = false;
  selectedCampusId = DEFAULT_CAMPUS_ID;
  studyVersion++;
  loadError = '';
}

function needsGoogleLink() {
  return Boolean(campusLogin && state.account?.role === 'student' && !state.account.googleEmail);
}

function rememberedCampus(accountId) {
  try {
    return getCampus(localStorage.getItem(`studymate:campus:${accountId}`))?.id ?? DEFAULT_CAMPUS_ID;
  } catch {
    return DEFAULT_CAMPUS_ID;
  }
}

function activeCampus() {
  return getCampus(selectedCampusId) ?? getCampus(DEFAULT_CAMPUS_ID);
}

function switchCampus(id) {
  if (!getCampus(id) || id === selectedCampusId) return;
  selectedCampusId = id;
  filters.region = '';
  matchRegion = '';
  matchMapView = '';
  if (!state.account.campusId) {
    try {
      localStorage.setItem(`studymate:campus:${state.account.id}`, id);
    } catch {
      // The campus selector still works when browser storage is restricted.
    }
  }
  render();
  app.querySelector('#campus-select')?.focus({ preventScroll: true });
}

function sessionsAtCampus() {
  return state.sessions.filter(session => (session.campusId ?? DEFAULT_CAMPUS_ID) === selectedCampusId);
}

function placesAtCampus() {
  const campus = activeCampus();
  const places = campus.id === DEFAULT_CAMPUS_ID ? PLACES : campus.regions.filter(region => region.placeType).map(region => ({
    name: region.label, region: region.name, type: region.placeType,
    note: '選擇公共區域共讀，並先確認場館的開放時間與使用規定。',
    mapQuery: `${campus.name} ${region.label}`,
  }));
  return { campusName: campus.name, places };
}

function mergeStudy(study) {
  const focusLog = new Map([...state.focusLog, ...study.focusLog, ...state.pendingFocus].map(entry => [entry.at, entry]));
  state = { ...state, ...study, focusLog: [...focusLog.values()].sort((a, b) => a.at.localeCompare(b.at)) };
}

async function refreshStudy() {
  const accountId = state.account?.id;
  if (!accountId) return false;
  const version = ++studyVersion;
  const study = await api('/study');
  if (state.account?.id !== accountId || version !== studyVersion) return false;
  mergeStudy(study);
  loadError = '';
  return true;
}

async function mutateStudy(path, data) {
  const accountId = state.account?.id;
  ++studyVersion;
  const study = await api(path, { method: 'POST', data });
  if (state.account?.id !== accountId) return false;
  ++studyVersion;
  mergeStudy(study);
  return true;
}

function syncFocus() {
  const accountId = state.account?.id;
  if (!accountId || !state.pendingFocus.length || focusSync === accountId) return;
  focusSync = accountId;
  void flushFocus(accountId);
}

async function flushFocus(accountId) {
  try {
    while (state.account?.id === accountId && state.pendingFocus.length) {
      const record = state.pendingFocus[0];
      await api('/study/focus', { method: 'POST', data: record });
      if (state.account?.id !== accountId) return;
      state.pendingFocus = state.pendingFocus.filter(entry => entry.at !== record.at);
      saveTimer();
    }
  } catch {
    if (state.account?.id === accountId) toast('專注紀錄尚未同步，重新整理資料時會再試。');
  } finally {
    if (focusSync === accountId) focusSync = null;
  }
}

function saveFocus(partial) {
  if (partial.focusLog) {
    const record = partial.focusLog.at(-1);
    state.pendingFocus = [...state.pendingFocus, record];
  }
  state = { ...state, ...partial };
  saveTimer();
  syncFocus();
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

function toast(message) {
  clearTimeout(toastTimeout);
  toastNode.textContent = message;
  toastNode.classList.add('visible');
  toastTimeout = setTimeout(() => toastNode.classList.remove('visible'), 3600);
}

const studyTools = createStudyTools({ read: () => state, save: saveFocus, icons: icon, toast, places: placesAtCampus, escape });

function activeView() {
  const hash = window.location.hash.slice(1);
  return ['match', 'plans', 'focus', 'places'].includes(hash) ? hash : 'explore';
}

function navigate(next, scroll = true) {
  if (window.location.hash !== `#${next}`) history.pushState(null, '', `#${next}`);
  if (next === 'explore') explorePane = 'list';
  view = next;
  render();
  if (next === 'match') void checkMatch();
  else if (match.status === 'matched') scheduleMatchCheck();
  if (scroll) window.scrollTo(0, 0);
}

function button(label, action, { glyph, variant = 'secondary', attrs = '' } = {}) {
  return `<button type="button" class="button button-${variant}" data-action="${action}" ${attrs}>${glyph ? icon(glyph) : ''}${label}</button>`;
}

function selectOptions(values, selected, placeholder) {
  return `${placeholder ? `<option value="">${placeholder}</option>` : ''}${values.map(item => {
    const [value, label] = Array.isArray(item) ? item : [item, item];
    return `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`;
  }).join('')}`;
}

function selectField(name, label, values, selected, placeholder) {
  return `<label class="field"><span>${label}</span><span class="select-wrap"><select name="${name}">${selectOptions(values, selected, placeholder)}</select>${icon('chevron')}</span></label>`;
}

function avatar(initials, color = 'moss') {
  const palette = ['moss', 'plum', 'sand', 'sky'];
  return `<span class="avatar avatar-${palette.includes(color) ? color : 'moss'}" aria-hidden="true">${escape(initials)}</span>`;
}

function renderShell(content) {
  return `
    <aside class="sidebar">
      <a class="brand" href="#explore" data-view="explore">
        <img src="./assets/icon.svg" width="40" height="40" alt="">
        <span><strong>StudyMate<span>.</span></strong><small>校園共讀</small></span>
      </a>
      <nav class="nav" aria-label="主要導覽"${state.account.role === 'student' ? ' data-match-nav' : ''}>
        ${navigation.filter(([key]) => key !== 'match' || state.account.role === 'student').map(([key, glyph, label]) => `<a href="#${key}" data-view="${key}"${key === view ? ' aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></a>`).join('')}
      </nav>
      <div class="sidebar-campus">
        <span class="sidebar-campus-icon">${icon('shield')}</span>
        <div><strong>${escape(activeCampus().shortName)}校園</strong><small>即時位置由你決定是否分享</small></div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <a class="brand mobile-brand" href="#explore" data-view="explore" aria-label="StudyMate 首頁">
          <img src="./assets/icon.svg" width="36" height="36" alt="">
          <strong>StudyMate<span>.</span></strong>
        </a>
        <span class="campus-label">${icon('pin')} ${escape(activeCampus().name)}</span>
        <div class="top-actions">
          ${state.account.role === 'admin' ? '<a class="button button-text admin-link" href="/admin">管理後台</a>' : ''}
          <button type="button" class="profile-trigger" data-action="profile" aria-label="我的帳號">${avatar(Array.from(state.account.name)[0])}<span>${escape(state.account.name)}</span>${icon('chevron')}</button>
        </div>
      </header>
      <main id="main-content" class="main-content" tabindex="-1">${content}</main>
    </div>`;
}

function render() {
  cleanup();
  cleanup = () => {};
  if (loading || !state.account || needsGoogleLink()) {
    app.innerHTML = renderAuth();
    return;
  }
  if (loadError) {
    app.innerHTML = renderShell(`<section class="empty-state"><h1>無法載入共讀資料</h1><p>${escape(loadError)}</p>${button('重新整理資料', 'refresh')}</section>`);
    return;
  }
  if (view === 'match' && state.account.role !== 'student') view = 'explore';
  const content = view === 'explore' ? renderExplore() : view === 'match' ? renderMatchPage() : view === 'plans' ? renderPlans() : studyTools.render(view);
  app.innerHTML = renderShell(content);
  const openedMatchMap = view === 'match' && match.status === 'matched';
  cleanup = view === 'explore' || openedMatchMap ? bindCampusMap(app) : studyTools.bind(app.querySelector('main'), view);
  if (view === 'explore') {
    updateExploreMap();
  }
  matchDeviceFix = undefined;
  if (openedMatchMap) {
    syncMatchMap(matchMapView);
    if (matchLocationRequested || liveMatchLocation(match.myLocationShare)) locateCampusPosition(app, { recenter: false });
  }
}

function passwordEntry(register, label) {
  return `<form class="dialog-form account-form" data-auth="${register ? 'register' : 'login'}">
    ${register ? '<label class="field"><span>暱稱</span><input name="name" autocomplete="nickname" maxlength="40" placeholder="共讀時顯示的名字" required></label>' : ''}
    <label class="field"><span>電子郵件</span><input type="email" autocomplete="username" name="email" maxlength="254" placeholder="you@example.com" required></label>
    <label class="field"><span>密碼</span><input type="password" name="password" autocomplete="${register ? 'new-password' : 'current-password'}" ${register ? 'minlength="8" placeholder="至少 8 個字元"' : ''} maxlength="128" required></label>
    <p class="account-error" data-request-error role="alert" hidden></p>
    <button class="button button-primary account-submit" type="submit">${label}</button>
  </form>`;
}

function googleEntry() {
  const notice = campusNotice ? `<p class="account-error campus-entry-notice" role="alert">${escape(campusNotice)}</p>` : '';
  if (needsGoogleLink()) {
    const account = state.account;
    return `<h2>連結 Google 帳號</h2>
      <p class="account-description">可連結一般 Gmail 或校園 Google 帳號，原本的邀約與預約會留在此帳號。</p>
      <p class="account-email campus-linked-account">${escape(account.email)}</p>
      ${notice}
      ${googleAuthForm(account)}
      <div class="account-switch">${button('登出', 'logout', { variant: 'text' })}</div>`;
  }
  return `<h2>歡迎來到 StudyMate</h2>
    <p class="account-description">一般 Gmail 可以登入後選擇校園，校園帳號會直接開啟所屬學校的地圖。</p>
    ${notice}
    ${googleAuthForm()}
    <div class="account-switch">${button(legacyLogin ? '收起舊帳號表單' : '連結舊 StudyMate 帳號', 'legacy-auth', { variant: 'text' })}</div>
    ${legacyLogin ? passwordEntry(false, '登入並連結 Google 帳號') : ''}`;
}

function googleAuthForm(account) {
  return `<form class="dialog-form account-form" method="get" action="/api/auth/campus/start">
    ${account ? `<input type="hidden" name="intent" value="link"><input type="hidden" name="account" value="${escape(account.id)}">` : ''}
    <input type="hidden" name="campus" value="any">
    <button class="button button-primary account-submit" type="submit">${account ? '連結 Google 帳號' : '使用 Google 帳號登入'}</button>
  </form>`;
}

function renderAuth() {
  const register = authMode === 'register';
  return `
    <main class="account-layout" id="main-content" tabindex="-1">
      <section class="account-welcome" aria-labelledby="welcome-heading">
        <div class="account-brand">
          <img src="./assets/icon.svg" width="88" height="88" alt="">
          <span><strong>StudyMate<span>.</span></strong><small>校園共讀</small></span>
        </div>
        <div class="account-welcome-copy">
          <h1 id="welcome-heading">找個夥伴，<br><em>一起把書讀完。</em></h1>
          <p>在校園找人共讀、預約時段，累積你的學習紀錄。</p>
        </div>
      </section>
      <section class="account-main" aria-label="StudyMate 帳號">
        ${loading ? '<div class="account-card"><p class="account-loading" role="status">正在連線…</p></div>' : loadError ? `
          <div class="account-card">
            <h2>請重新連線</h2><p class="account-description">${escape(loadError)}</p>
            ${button('重新連線', 'retry-bootstrap', { variant: 'primary' })}
          </div>` : `
          <div class="account-card">
            ${campusLogin ? googleEntry() : `
            <h2>${register ? '建立共讀帳號' : '歡迎回來'}</h2>
            <p class="account-description">${register ? '建立帳號後，就可以發起或加入共讀。' : 'Google 登入尚未啟用，可先使用電子郵件登入。'}</p>
            ${campusNotice ? `<p class="account-error campus-entry-notice" role="alert">${escape(campusNotice)}</p>` : ''}
            ${passwordEntry(register, register ? '註冊並登入' : '登入')}
            <div class="account-switch"><span>${register ? '已經有帳號？' : '第一次使用？'}</span>${button(register ? '我要登入' : '建立帳號', 'auth-mode', { variant: 'text' })}</div>`}
            <a class="account-setup-link" href="/admin">${adminSetup ? '管理員初始設定' : '管理員登入'}</a>
          </div>`}
      </section>
    </main>`;
}

function renderCampusPicker() {
  return `<label class="field campus-map-picker"><span>切換校園</span>
    <span class="select-wrap"><select id="campus-select" aria-label="切換校園">${selectOptions(CAMPUSES.map(campus => [campus.id, campus.shortName]), selectedCampusId)}</select>${icon('chevron')}</span>
  </label>`;
}

function renderExplore() {
  const now = Date.now();
  const campus = activeCampus();
  const campusPlaces = getCampusPlaces(campus.id);
  const pending = Object.values(state.reservations).filter(item => item.status === 'pending' && !hasEnded(item.session)).length;
  const upcoming = Object.values(state.reservations).filter(item => item.status === 'confirmed' && !hasEnded(item.session)).length;
  const publish = button('發起邀約', 'publish', { glyph: 'plus' });
  return `
    <div class="explore-page">
      <div class="explore-toolbar">
        ${renderCampusPicker()}
        <button type="button" class="button button-secondary explore-pane-toggle" data-action="explore-pane"
          aria-controls="explore-map" aria-expanded="${explorePane === 'map'}">${explorePaneLabel()}</button>
        <div class="explore-toolbar-actions">
          ${button('定位我現在的位置', 'locate-explore', { glyph: 'compass', attrs: 'aria-controls="explore-map"' })}
          ${publish}
        </div>
      </div>
      <div class="explore-grid" data-pane="${explorePane}">
        <section class="discovery" id="explore-list" aria-labelledby="discovery-title">
          <header class="section-heading heading-with-action" id="discovery-heading">
            <h1 id="discovery-title" tabindex="-1">找讀書夥伴</h1>
            ${button('重新整理', 'refresh', { glyph: 'rotate', variant: 'text', attrs: 'aria-label="重新整理邀約"' })}
          </header>
          ${renderInvitations(now)}
          ${renderCampusPicks(campus, campusPlaces.filter(place => place.kind === 'cafe').length)}
        </section>
        <div class="explore-map" id="explore-map">
          ${renderCampusMap({
            campus, selectedRegion: filters.region, invitations: mapInvitations(now), places: campusPlaces,
          })}
        </div>
      </div>
      <aside class="dashboard-aside explore-support" aria-label="讀書小工具">
        <section class="aside-panel plan-summary">
          <span class="tile-icon">${icon('calendar')}</span>
          <h2>我的讀書計畫</h2>
          <div class="summary-counts"><div><strong>${pending}</strong><span>等待確認</span></div><div><strong>${upcoming}</strong><span>已確認</span></div></div>
          <a class="button button-secondary" href="#plans" data-view="plans">查看我的預約</a>
        </section>
        <section class="aside-panel focus-summary">
          <span class="tile-icon">${icon('timer')}</span>
          <h2>專注一下</h2>
          <p>用番茄鐘安排專心讀書的時間。</p>
          <a class="button button-primary" href="#focus" data-view="focus">${icon('play')} 開啟計時器</a>
        </section>
      </aside>
    </div>`;
}

function renderInvitations(now = Date.now()) {
  const results = matchingSessions(now);
  return `
    <div class="filter-bar">
      <div class="segmented" role="group" aria-label="依時段篩選">
        ${[['all', '全部'], ['now', '正在揪團'], ['later', '可預約']].map(([key, label]) => `<button type="button" data-action="timing" data-value="${key}" aria-pressed="${filters.timing === key}">${key === 'now' ? '<span class="dot"></span>' : ''}${label}</button>`).join('')}
      </div>
      ${button('篩選', 'filters', { glyph: 'sliders' })}
    </div>
    <div class="results-line">
      <div class="results-summary">
        <span id="result-count" aria-live="polite">${resultCount(results)}</span>
        <div class="active-filters" id="active-filters" role="group" aria-label="已套用篩選">${renderFilterChips()}</div>
      </div>
      <label class="sort-control"><span class="sr-only">排序</span><select id="sort">${selectOptions([['score', '媒合度優先'], ['distance', '區域距離優先'], ['time', '時間優先']], filters.sort)}</select>${icon('chevron')}</label>
    </div>
    <p class="explore-online-note" data-online-scope${filters.mode === 'online' ? '' : ' hidden'}>${onlineScopeNote}</p>
    <div id="results" class="session-grid explore-results">${renderResults(results)}</div>`;
}

function renderMatchPage() {
  const matched = match.status === 'matched';
  const campus = getCampus(match.campusId) ?? activeCampus();
  const panel = `<div data-match-panel>${renderMatchPanel()}</div>`;
  return `<div class="match-page">
    <header class="section-heading heading-with-action match-page-heading">
      <h1 id="match-page-title" tabindex="-1">${matched ? '配對地圖' : '配對'}</h1>
      ${match.status === 'idle' || match.status === 'expired' ? renderCampusPicker() : ''}
    </header>
    <p class="sr-only" role="status" data-match-announcement></p>
    ${matched ? `<div class="match-map-layout">
      <div id="explore-map">${renderCampusMap({
        campus, places: getCampusPlaces(campus.id), rendezvous: match.rendezvous, sharedCafe: match.cafe,
        matchCoordinates: true, actions: `<div data-match-map-share>${renderMatchMapShare()}</div>`,
      })}</div>
      <div class="match-map-column">
        <div data-match-location>${renderMatchLocation()}</div>
        ${panel}
      </div>
    </div>` : `<div class="match-page-entry">${panel}</div>`}
  </div>`;
}

function renderMatchPanel() {
  const choosing = match.status === 'idle' || match.status === 'expired';
  const campus = (!choosing && getCampus(match.campusId)) || activeCampus();
  const regions = campus.regions.map(({ name }) => name);
  const preferredRegion = (state.account.campusId ?? DEFAULT_CAMPUS_ID) === campus.id ? state.account.region : '';
  const region = choosing ? matchRegion || (match.campusId === campus.id ? match.region : '') || preferredRegion : match.region;
  const statuses = {
    idle: ['與附近同學配對', '選擇你所在的校園區域，優先配對同校距離你最近、也正在等待的同學。'],
    searching: ['正在尋找附近的學生', '找到附近的同學後，你們都可以選擇是否接受配對。'],
    found: ['找到附近的同學', '雙方接受後，會開啟配對地圖。'],
    waiting: ['等待對方確認', '對方也接受後，就會自動開啟配對地圖。'],
    matched: ['配對成功！', '先到校園集合點碰面，再一起去咖啡廳。'],
    expired: ['這次沒有配對成功', match.reason === 'search' ? '目前沒有配到附近的同學，可以再試一次。' : '這次配對已結束，可以再試一次。'],
  };
  const [title, description] = statuses[match.status];
  const confirming = match.status === 'found' || match.status === 'waiting';
  const searching = match.status === 'searching';
  const isMatched = match.status === 'matched';
  const timerLabel = searching ? '已等待' : '確認倒數';
  return `<section class="match-panel" data-status="${match.status}" aria-labelledby="match-title">
    <div class="match-panel-copy">
      <p class="match-eyebrow">${icon('pin')} ${escape(campus.shortName)} · ${escape(!choosing && !isMatched && region ? region : campus.area)}</p>
      <h2 id="match-title" class="match-title" tabindex="-1">${title}</h2>
      <p class="match-description">${description}</p>
      ${choosing ? `<form class="match-form" data-match-form>
        <label class="field"><span>你在哪個區域？</span><span class="select-wrap">
          <select name="region" required>${selectOptions(regions, region, '選擇校園區域')}</select>${icon('chevron')}
        </span></label>
        <label class="check-field match-position-opt-in"><input type="checkbox" name="shareLocation"${matchAutoShare ? ' checked' : ''}>配對成功後，分享我的即時位置（10 分鐘）</label>
        <button type="submit" class="button button-lime">${icon('bolt')} ${match.status === 'expired' ? '重新配對' : '開始配對'}</button>
        <p role="alert" data-request-error hidden></p>
      </form>` : isMatched ? '' : `<div class="match-actions">
        ${searching ? matchCommand('取消配對', 'cancel') : ''}
        ${match.status === 'found' ? matchCommand('接受配對', 'accept', 'lime', 'check') : ''}
        ${confirming ? matchCommand(match.status === 'found' ? '婉拒' : '取消配對', 'decline') : ''}
      </div>`}
      <p role="status" class="match-connection" data-match-connection${matchConnectionLost ? '' : ' hidden'}>連線暫時中斷，正在重新連線。</p>
    </div>
    <div class="match-visual">
      <div class="match-radar" aria-hidden="true">
        <span class="match-radar-ring"></span><span class="match-radar-ring"></span><span class="match-radar-ring"></span>
        <span class="match-radar-sweep"></span><span class="match-radar-point"></span><span class="match-radar-point"></span>
        <span class="match-radar-center">${icon(isMatched ? 'check' : confirming ? 'users' : 'pin')}</span>
      </div>
      ${searching || confirming ? `<p class="match-timer">${icon('clock')} <span>${timerLabel}</span> <span data-match-clock>${matchClockLabel()}</span></p>` : ''}
    </div>
    ${isMatched ? renderMatchItinerary() : ''}
  </section>`;
}

function matchCommand(label, value, variant = 'glass', glyph) {
  return button(label, 'match-command', { variant, glyph, attrs: `data-value="${value}" data-id="${escape(match.ticketId)}"` });
}

function matchMapButton(label, stop) {
  return button(label, 'match-map', { glyph: 'map', variant: 'glass', attrs: `data-value="${stop}" aria-controls="explore-map"` });
}

function matchDirections(label, destination, origin) {
  return `<a class="button button-lime" href="${escape(walkingDirectionsURL(destination, origin))}" target="_blank" rel="noopener noreferrer">${icon('compass')}${label}</a>`;
}

function liveMatchLocation(share) {
  return share?.expiresAt > Date.now() ? share : undefined;
}

function renderMatchMapShare() {
  const shared = liveMatchLocation(match.myLocationShare);
  return `${shared ? matchCommand('停止分享位置', 'stop-location', 'secondary', 'close') : matchLocationRequested
    ? matchCommand('取消定位分享', 'stop-location', 'secondary', 'close')
    : button('分享即時位置（10 分鐘）', 'share-match-location', { glyph: 'pin', variant: 'primary' })}
    ${matchLocationRequested ? '<p role="status">正在取得定位…</p>' : ''}
    ${matchLocationError ? `<p role="alert">${escape(matchLocationError)}</p>` : ''}`;
}

function renderMatchLocation() {
  const myShare = liveMatchLocation(match.myLocationShare);
  const peerShare = liveMatchLocation(match.peerLocation);
  return `<section class="match-location" aria-labelledby="match-location-title">
    <h2 id="match-location-title">即時位置</h2>
    <p class="match-stop-detail">開啟後，對方可在 10 分鐘內看到你移動中的位置。你可以隨時停止。</p>
    ${myShare ? `<p class="match-shared-status">${icon('check')}分享中，有效至 ${timeFormat.format(myShare.expiresAt)}</p>` : ''}
    ${peerShare ? `<div class="match-peer-location">
      <p class="match-shared-status">${icon('pin')}對方的位置可查看至 ${timeFormat.format(peerShare.expiresAt)}</p>
      <div class="match-stop-actions">
        ${matchMapButton('在地圖上看對方', 'peer')}
        <a class="button button-lime" data-match-peer-directions href="${escape(walkingDirectionsURL(peerShare.position))}" target="_blank" rel="noopener noreferrer">${icon('compass')}導航到對方位置</a>
      </div>
    </div>` : '<p class="match-stop-detail">等待對方分享即時位置。</p>'}
  </section>`;
}

function renderMatchItinerary() {
  const { rendezvous, cafe } = match;
  const cafes = getCampusPlaces(match.campusId).filter(place => place.kind === 'cafe');
  if (cafe && !cafes.some(place => place.id === cafe.id)) cafes.unshift(cafe);
  return `<div class="match-itinerary">
    ${rendezvous ? `<ol class="match-stops" aria-label="共讀路線">
      <li class="match-stop">
        <span class="match-stop-icon">${icon('pin')}</span>
        <div class="match-stop-body">
          <p class="match-stop-label">先到集合點</p>
          <h3>${escape(rendezvous.name)}</h3>
          ${rendezvous.region && rendezvous.region !== rendezvous.name ? `<p class="match-stop-detail">${escape(rendezvous.region)}</p>` : ''}
          <div class="match-stop-actions">
            ${matchMapButton('查看集合點路線', 'rendezvous')}
            ${matchDirections('導航到集合點', rendezvous.position)}
          </div>
        </div>
      </li>
      <li class="match-stop">
        <span class="match-stop-icon">${icon('cup')}</span>
        <div class="match-stop-body">
          <p class="match-stop-label">碰面後一起去咖啡廳</p>
          ${cafe ? `<h3>${escape(cafe.name)}</h3>` : '<p class="match-stop-detail">兩人都會看到選定的咖啡廳。</p>'}
          ${cafes.length ? `<form class="match-form match-cafe-form" data-match-cafe>
            <label class="field"><span>共同目的地</span><span class="select-wrap">
              <select name="cafeId" required>${selectOptions(cafes.map(place => [place.id, place.name]), cafe?.id, '選擇咖啡廳')}</select>${icon('chevron')}
            </span></label>
            <button type="submit" class="button button-glass">${icon('check')}選定咖啡廳</button>
            <p role="alert" data-request-error hidden></p>
          </form>` : '<p class="match-stop-detail">這所校園目前沒有咖啡廳資料。</p>'}
          <div class="match-stop-actions">
            ${cafes.length ? matchMapButton('看咖啡廳地圖', 'cafe') : ''}
            ${cafe ? matchDirections('從集合點導航', cafe.position, rendezvous.position) : ''}
          </div>
        </div>
      </li>
    </ol>` : '<p class="match-stop-detail">暫時無法載入集合點，請重新整理後再試。</p>'}
    ${matchCommand('返回配對', 'dismiss', 'glass', 'rotate')}
  </div>`;
}

function matchClockLabel() {
  const searching = match.status === 'searching';
  const now = Date.now();
  const seconds = Math.max(0, searching ? Math.floor((now - match.startedAt) / 1_000) : Math.ceil((match.expiresAt - now) / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function resetMatch() {
  matchRevision++;
  clearTimeout(matchPoll);
  clearInterval(matchClock);
  clearTimeout(matchLocationExpiry);
  clearTimeout(matchLocationUploadTimer);
  match = { status: 'idle' };
  matchRegion = '';
  matchMapView = '';
  matchCheck = null;
  matchActing = false;
  matchAutoShare = false;
  matchLocationRequested = false;
  matchLocationError = '';
  matchDeviceFix = undefined;
  matchLocationUpload = undefined;
  lastLocationUploadAt = 0;
  matchConnectionLost = false;
}

function renderMatchUpdate(focus = false) {
  const container = app.querySelector('[data-match-panel]');
  if (!container) return;
  const moveFocus = focus || container.contains(document.activeElement);
  container.innerHTML = renderMatchPanel();
  if (moveFocus) container.querySelector('#match-title').focus({ preventScroll: true });
}

function renderMatchLocationUpdate() {
  const container = app.querySelector('[data-match-location]');
  if (container) container.innerHTML = renderMatchLocation();
  const controls = app.querySelector('[data-match-map-share]');
  if (controls) {
    const focused = controls.contains(document.activeElement);
    controls.innerHTML = renderMatchMapShare();
    if (focused) controls.querySelector('button')?.focus({ preventScroll: true });
  }
}

function applyMatch(next, focus = false) {
  const previous = match;
  next = {
    ...next, myLocationShare: liveMatchLocation(next.myLocationShare), peerLocation: liveMatchLocation(next.peerLocation),
  };
  const changed = previous.status !== next.status || previous.ticketId !== next.ticketId;
  const cafeChanged = previous.cafe?.id !== next.cafe?.id;
  const peerChanged = previous.peerLocation?.expiresAt !== next.peerLocation?.expiresAt
    || previous.peerLocation?.updatedAt !== next.peerLocation?.updatedAt
    || previous.peerLocation?.position?.[0] !== next.peerLocation?.position?.[0]
    || previous.peerLocation?.position?.[1] !== next.peerLocation?.position?.[1];
  const sharingChanged = previous.myLocationShare?.expiresAt !== next.myLocationShare?.expiresAt;
  match = next;
  matchConnectionLost = false;
  if (changed && next.status === 'matched') {
    matchLocationRequested = matchAutoShare;
    matchAutoShare = false;
    matchLocationError = '';
    lastLocationUploadAt = 0;
  } else if (changed && ['idle', 'expired'].includes(next.status)) {
    matchAutoShare = false;
    matchLocationRequested = false;
    matchLocationError = '';
    clearTimeout(matchLocationUploadTimer);
  }
  if (next.myLocationShare) matchLocationRequested = false;
  const mapChanged = changed && (previous.status === 'matched' || next.status === 'matched');
  if (view === 'match' && mapChanged) {
    render();
    window.scrollTo(0, 0);
    app.querySelector('#match-page-title')?.focus({ preventScroll: true });
  } else {
    if (changed || cafeChanged) renderMatchUpdate(focus);
    if (sharingChanged || previous.peerLocation?.expiresAt !== next.peerLocation?.expiresAt) renderMatchLocationUpdate();
    else if (peerChanged && next.peerLocation) {
      const link = app.querySelector('[data-match-peer-directions]');
      if (link) link.href = walkingDirectionsURL(next.peerLocation.position);
    }
  }
  scheduleLocationExpiry();
  const notice = app.querySelector('[data-match-connection]');
  if (notice) notice.hidden = true;
  if (previous.status === 'matched' && next.status !== 'matched') {
    matchMapView = '';
    clearCampusWalkingRoute(app);
  } else if (cafeChanged && matchMapView === 'cafe') {
    clearCampusWalkingRoute(app);
  }
  if (peerChanged && !next.peerLocation && matchMapView === 'peer') matchMapView = '';
  if (view === 'match' && (cafeChanged || peerChanged || sharingChanged)) {
    syncMatchMap();
  }
  if (cafeChanged && !changed && next.cafe) {
    const announcement = app.querySelector('[data-match-announcement]');
    if (announcement) announcement.textContent = `共同目的地已更新為${next.cafe.name}。`;
  }
  if (Boolean(previous.peerLocation) !== Boolean(next.peerLocation) && !changed) {
    const announcement = app.querySelector('[data-match-announcement]');
    if (announcement) announcement.textContent = next.peerLocation ? '對方已分享位置。' : '對方的分享位置已結束。';
  }
  if (!changed) return;

  clearInterval(matchClock);
  if (activeMatchStatuses.has(match.status)) {
    matchClock = setInterval(() => {
      const clock = app.querySelector('[data-match-clock]');
      if (clock) clock.textContent = matchClockLabel();
    }, 1_000);
  }
  const panel = app.querySelector('[data-match-panel]');
  const panelVisible = Boolean(panel?.getClientRects().length);
  if (panelVisible) {
    const heading = panel.querySelector('#match-title');
    app.querySelector('[data-match-announcement]').textContent = document.activeElement === heading ? '' : heading.textContent;
  } else if (next.status === 'found') {
    toast('找到附近的同學了，請回到「配對」確認。');
  } else if (next.status === 'matched') {
    toast('配對成功！開啟「配對」查看你們的地圖。');
  }
}

function scheduleLocationExpiry() {
  clearTimeout(matchLocationExpiry);
  const expiresAt = Math.min(match.myLocationShare?.expiresAt ?? Infinity, match.peerLocation?.expiresAt ?? Infinity);
  if (Number.isFinite(expiresAt)) matchLocationExpiry = setTimeout(() => applyMatch(match), Math.max(0, expiresAt - Date.now()));
}

function watchesMatchedResult() {
  return match.status === 'matched' && view === 'match' && document.visibilityState === 'visible';
}

function scheduleMatchCheck(retry = false) {
  clearTimeout(matchPoll);
  if (activeMatchStatuses.has(match.status) || (retry && match.status !== 'matched')) {
    matchPoll = setTimeout(checkMatch, matchPollInterval);
  } else if (watchesMatchedResult()) {
    matchPoll = setTimeout(checkMatch, matchPollInterval);
  }
}

async function checkMatch() {
  if (matchCheck || matchActing || state.account?.role !== 'student' || needsGoogleLink()) return;
  const revision = matchRevision;
  const request = api('/study/match', { method: 'POST', data: { action: 'check' } });
  matchCheck = request;
  let retry = false;
  try {
    const next = await request;
    if (revision === matchRevision) applyMatch(next);
  } catch {
    if (revision === matchRevision && (activeMatchStatuses.has(match.status) || watchesMatchedResult())) {
      matchConnectionLost = true;
      const notice = app.querySelector('[data-match-connection]');
      if (notice) notice.hidden = false;
      retry = true;
    }
  } finally {
    if (matchCheck === request) matchCheck = null;
    if (revision === matchRevision) scheduleMatchCheck(retry);
  }
}

async function changeMatch(data, focus = true) {
  const revision = ++matchRevision;
  matchActing = true;
  clearTimeout(matchPoll);
  let retry = false;
  try {
    await matchCheck?.catch(() => {});
    if (revision !== matchRevision) return;
    const next = await api('/study/match', { method: 'POST', data });
    if (revision === matchRevision) applyMatch(next, focus);
  } catch (error) {
    retry = true;
    throw error;
  } finally {
    if (revision === matchRevision) {
      matchActing = false;
      scheduleMatchCheck(retry);
    }
  }
}

function selectMatchCafe(cafeId) {
  return changeMatch({ action: 'select-cafe', ticketId: match.ticketId, cafeId });
}

function shareMatchLocation() {
  if (view !== 'match' || match.status !== 'matched' || matchLocationRequested) return;
  if (!navigator.geolocation?.watchPosition) {
    matchLocationError = '這個瀏覽器無法取得定位。';
    renderMatchLocationUpdate();
    return;
  }
  matchLocationRequested = true;
  matchLocationError = '';
  renderMatchLocationUpdate();
  locateCampusPosition(app, { recenter: false });
}

function scheduleLocationUpload() {
  clearTimeout(matchLocationUploadTimer);
  if (!watchesMatchedResult() || !matchDeviceFix || (!matchLocationRequested && !liveMatchLocation(match.myLocationShare))) return;
  matchLocationUploadTimer = setTimeout(uploadMatchLocation, Math.max(0, lastLocationUploadAt + locationUploadInterval - Date.now()));
}

async function uploadMatchLocation() {
  const sharing = liveMatchLocation(match.myLocationShare);
  const fix = matchDeviceFix;
  if (!watchesMatchedResult() || !fix || (!matchLocationRequested && !sharing)) return;
  if (matchLocationUpload || activeRequest || matchActing) {
    matchLocationUploadTimer = setTimeout(uploadMatchLocation, 250);
    return;
  }
  const ticketId = match.ticketId;
  const position = fix.position.map(coordinate => Math.round(coordinate * 10_000) / 10_000);
  lastLocationUploadAt = Date.now();
  const request = changeMatch({ action: sharing ? 'update-location' : 'share-location', ticketId, position }, false);
  matchLocationUpload = request;
  try {
    await request;
  } catch (error) {
    if (match.ticketId === ticketId && !sharing) {
      matchLocationRequested = false;
      matchLocationError = error.message;
      renderMatchLocationUpdate();
    }
  } finally {
    if (matchLocationUpload === request) matchLocationUpload = undefined;
    if (match.ticketId === ticketId && matchDeviceFix !== fix) scheduleLocationUpload();
  }
}

async function stopMatchLocation(data) {
  matchLocationRequested = false;
  clearTimeout(matchLocationUploadTimer);
  await matchLocationUpload?.catch(() => {});
  if (match.ticketId !== data.ticketId) return;
  await changeMatch(data, false);
  renderMatchLocationUpdate();
}

function renderCampusPicks(campus, cafeCount) {
  return `<section class="campus-picks" aria-labelledby="campus-picks-title">
    <header class="campus-picks-heading">
      <h2 id="campus-picks-title">校園精選</h2>
      <img class="campus-picks-mascot" src="./assets/campus-mascot.webp" alt="" width="224" height="224" loading="lazy" decoding="async">
    </header>
    <div class="campus-picks-grid">
      ${cafeCount ? `<article class="campus-pick">
        <img src="./assets/campus-cafe.webp" alt="" width="960" height="480" loading="lazy">
        <div class="campus-pick-copy">
          <h3>校園附近的咖啡廳</h3>
          <p>${escape(campus.shortName)}周邊 ${cafeCount} 間精選咖啡廳</p>
          ${button('在地圖上看咖啡廳', 'campus-cafes', { glyph: 'cup', variant: 'feature' })}
        </div>
      </article>` : ''}
      <article class="campus-pick">
        <img src="./assets/study-banner.webp" alt="" width="960" height="480" loading="lazy">
        <div class="campus-pick-copy">
          <h3>校園讀書空間</h3>
          <p>圖書館與適合共讀的校園空間</p>
          <a href="#places" class="button button-feature" data-view="places">${icon('library')} 查看讀書空間</a>
        </div>
      </article>
    </div>
  </section>`;
}

function hasEnded(session, now = Date.now()) {
  return Date.parse(session.end) <= now;
}

function canJoinSession(session, now = Date.now()) {
  const reservation = state.reservations[session.id];
  return !isOwnSession(session) && !session.closed && !hasEnded(session, now)
    && session.joined < session.capacity && (!reservation || reservation.status === 'cancelled');
}

function matchingCandidates(now, acrossRegions = false) {
  return sessionsAtCampus().filter(session => (
    !session.closed && !hasEnded(session, now)
    && (!filters.subject || session.subject === filters.subject)
    && (!filters.mode || session.mode === filters.mode)
    && (acrossRegions || !filters.region || session.region === filters.region)
    && (!filters.style || session.style === filters.style)
    && (!filters.department || session.department === filters.department)
    && (!filters.cross || session.department !== state.account.department)
    && (filters.timing !== 'now' || (isLive(session, now) && canJoinSession(session, now)))
    && (filters.timing !== 'later' || Date.parse(session.start) > now)
  ));
}

function mapInvitations(now) {
  return matchingCandidates(now, true);
}

function matchingSessions(now) {
  const nearHome = (state.account.campusId ?? DEFAULT_CAMPUS_ID) === selectedCampusId;
  const preferences = { ...state.account, region: nearHome ? state.account.region : '', start: now, end: now + 90 * minute };
  for (const key of ['region', 'subject', 'style']) {
    if (filters[key]) preferences[key] = filters[key];
  }
  return matchingCandidates(now).map(session => ({ session, ...scoreSession(session, preferences) })).sort((a, b) => {
    if (filters.sort === 'distance') return (a.distance ?? Infinity) - (b.distance ?? Infinity) || b.score - a.score;
    if (filters.sort === 'time') return Date.parse(a.session.start) - Date.parse(b.session.start);
    return b.score - a.score;
  });
}

function renderResults(results) {
  if (results.length) return results.map(renderCard).join('');
  if (filters.timing === 'now') {
    return `<div class="empty-state"><span class="tile-icon">${icon('search')}</span>
      <h3>${activeFilters().length ? '目前沒有符合條件的即時邀約' : '目前沒有其他人正在揪團'}</h3>
      <div class="empty-actions">
        ${state.account.role === 'student' ? `<a class="button button-primary" href="#match" data-view="match">${icon('bolt')}前往配對</a>` : ''}
        ${button('現在發起一團', 'publish', { glyph: 'plus', attrs: 'data-value="now"' })}
        ${button('看可預約時段', 'browse-upcoming')}
      </div>
    </div>`;
  }
  const hasInvites = sessionsAtCampus().some(session => !session.closed && !hasEnded(session));
  return `
    <div class="empty-state"><span class="tile-icon">${icon('search')}</span>
      <h3>${filters.timing === 'later' ? '目前沒有符合條件的可預約邀約'
        : hasInvites ? '目前沒有符合條件的邀約' : '這個校園目前沒有共讀邀約'}</h3>
      <div class="empty-actions">
        ${button(hasInvites ? '發起符合條件的邀約' : '發起第一場邀約', 'publish', { glyph: 'plus', variant: 'primary' })}
        ${activeFilters().length ? button('清除篩選', 'reset-filters') : ''}
      </div>
    </div>`;
}

function resultCount(results) {
  return `${results.length} 個邀約`;
}

function activeFilters() {
  return [
    ['subject', filters.subject],
    ['mode', { 'in-person': '實體', online: '線上' }[filters.mode]],
    ['region', filters.region],
    ['style', filters.style],
    ['department', filters.department],
    ['cross', filters.cross ? '排除同系學生' : ''],
  ].filter(([, label]) => label);
}

function renderFilterChips() {
  return activeFilters().map(([key, label]) => `<button type="button" class="filter-chip" data-action="remove-filter"
    data-value="${key}" aria-label="移除篩選：${escape(label)}">${escape(label)} <span aria-hidden="true">×</span></button>`).join('');
}

function removeFilter(key) {
  const index = activeFilters().findIndex(([name]) => name === key);
  if (index === -1) return;
  filters[key] = initialFilters[key];
  refreshResults();
  const chips = document.querySelectorAll('#active-filters .filter-chip');
  (chips[Math.min(index, chips.length - 1)] ?? app.querySelector('[data-action="filters"]'))?.focus();
}

function explorePaneLabel() {
  return explorePane === 'map' ? '看邀約' : '看地圖';
}

function showExplorePane(pane) {
  explorePane = pane;
  app.querySelector('.explore-grid').dataset.pane = pane;
  const toggle = app.querySelector('[data-action="explore-pane"]');
  toggle.setAttribute('aria-expanded', String(pane === 'map'));
  toggle.textContent = explorePaneLabel();
}

function matchMapDestination() {
  return {
    rendezvous: match.rendezvous, cafe: match.cafe, peerLocation: liveMatchLocation(match.peerLocation),
    myLocationShare: liveMatchLocation(match.myLocationShare), localPosition: matchDeviceFix?.position,
    livePair: true,
  };
}

function syncMatchMap(focus) {
  if (view !== 'match' || match.status !== 'matched') return null;
  return viewCampusDestination(app, { ...matchMapDestination(), focus, cafeOnly: focus === 'cafe' });
}

async function showMatchDestination(focus) {
  const { campusId, region, rendezvous, cafe } = match;
  if (!rendezvous || (focus === 'peer' && !liveMatchLocation(match.peerLocation))) return;
  matchMapView = focus;
  clearCampusWalkingRoute(app);
  const viewport = syncMatchMap(focus);
  app.querySelector('#explore-map').scrollIntoView({ block: 'start' });
  viewport?.focus({ preventScroll: true });
  if (focus === 'peer') return;
  const route = focus === 'rendezvous'
    ? region && region !== rendezvous.region && { campusId, fromRegion: region, toRegion: rendezvous.region }
    : cafe && { campusId, fromRegion: rendezvous.region, cafeId: cafe.id };
  if (!route) return;
  try {
    await showCampusWalkingRoute(app, { ...route, accountId: state.account?.id });
  } catch {
    toast('暫時無法預覽步行路線，可以使用 Google 地圖導航。');
  }
}

function updateExploreMap(now = Date.now()) {
  updateCampusMapSelection(app, filters.region, mapInvitations(now));
  for (const control of app.querySelectorAll('[data-action="map-region"]:not([data-value=""])')) {
    if (filters.mode === 'online') control.setAttribute('aria-disabled', 'true');
    else control.removeAttribute('aria-disabled');
  }
}

function refreshResults() {
  const container = document.querySelector('#results');
  if (!container) return;
  const now = Date.now();
  const results = matchingSessions(now);
  container.innerHTML = renderResults(results);
  document.querySelector('#result-count').textContent = resultCount(results);
  document.querySelector('#active-filters').innerHTML = renderFilterChips();
  app.querySelector('[data-online-scope]').hidden = filters.mode !== 'online';
  updateExploreMap(now);
  for (const control of app.querySelectorAll('[data-action="timing"]')) {
    control.setAttribute('aria-pressed', String(control.dataset.value === filters.timing));
  }
  document.querySelector('#sort').value = filters.sort;
}

function formatSessionStart(start) {
  const day = dayFormat.format(start);
  const prefix = day === dayFormat.format(Date.now()) ? '今天' : day;
  return `${prefix} ${timeFormat.format(start)}`;
}

function formatSlot(session) {
  const start = new Date(session.start);
  const end = new Date(session.end);
  const endDay = dayFormat.format(end) === dayFormat.format(start) ? '' : `${dayFormat.format(end)} `;
  return `${formatSessionStart(start)}–${endDay}${timeFormat.format(end)}`;
}

function sessionFacts(session, distance, showCampus = false) {
  const campus = showCampus ? getCampus(session.campusId ?? DEFAULT_CAMPUS_ID)?.shortName : '';
  const venue = session.quickMatch ? getCampus(session.campusId)?.regions.find(({ name }) => name === session.region)?.label : null;
  const place = session.mode === 'online' ? '線上共讀' : venue ?? session.region;
  const where = campus ? `${campus} · ${place}` : place;
  const details = distance === 0 ? ' · 同一區域' : distance ? ` · 約 ${distance} 公尺` : '';
  return `
    <ul class="session-facts">
      <li>${icon('clock')}<span>${formatSlot(session)}</span></li>
      <li>${icon(session.mode === 'online' ? 'laptop' : 'pin')}<span>${escape(where)}${details}</span></li>
    </ul>`;
}

function isOwnSession(session) {
  return Boolean(state.account && session.hostId === state.account.id);
}

function renderCard({ session, score }) {
  const live = isLive(session);
  const startLabel = formatSessionStart(new Date(session.start));
  const campus = getCampus(session.campusId ?? DEFAULT_CAMPUS_ID)?.shortName ?? session.school;
  const place = session.mode === 'online' ? '線上共讀' : session.region;
  const remaining = session.capacity - session.joined;
  return `
    <article class="session-card">
      <p class="session-lead"><time datetime="${escape(session.start)}">${startLabel}</time><span aria-hidden="true">｜</span><strong>${escape(session.subject)}</strong></p>
      <p class="session-meta">${escape(campus)}・${escape(place)}・${escape(session.style)}・${remaining > 0 ? `剩 ${remaining} 位` : '已額滿'}</p>
      <h3>${escape(session.title)}</h3>
      <div class="card-top"><span class="status-pill ${live ? 'status-live' : 'status-later'}"><span class="dot"></span>${live ? '正在揪團' : '開放預約'}</span>
        ${isOwnSession(session) ? '<span class="score">我的邀約</span>' : `<span class="score" title="參考科目、讀書習慣、時段與概略區域">${icon('spark')} ${score}% 媒合度</span>`}
      </div>
      <footer class="card-footer">
        <div class="host">${avatar(session.initials, session.avatarColor)}<span><strong>${escape(session.host)}</strong><small>${escape(session.department)}</small></span></div>
        ${button('查看邀約', 'details', { variant: 'card', attrs: `data-id="${escape(session.id)}" aria-label="查看邀約：${escape(session.title)}"` })}
      </footer>
    </article>`;
}

const statusLabels = { pending: '等待對方確認', confirmed: '已確認', completed: '共讀完成', cancelled: '已取消' };

function renderPlans() {
  const reservations = Object.values(state.reservations).sort((a, b) => b.updatedAt - a.updatedAt);
  const own = state.sessions.filter(isOwnSession);
  const incoming = state.incoming.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  return `
    <header class="tool-heading heading-with-action">
      <div><h1>我的預約</h1><p>查看加入申請、管理發起的邀約和共讀時段。</p></div>
      ${button('重新整理', 'refresh', { glyph: 'rotate', variant: 'text', attrs: 'aria-label="重新整理預約"' })}
    </header>
    <div class="plans-grid">
      <section class="tool-panel plan-list" aria-labelledby="reservation-heading">
        <h2 id="reservation-heading">${icon('calendar')} 我的共讀</h2>
        ${reservations.length ? reservations.map(item => {
          const { id, session, status } = item;
          const attrs = `data-id="${escape(id)}"`;
          const expired = hasEnded(session);
          return `<article class="plan-item">
            <span class="status-pill ${status === 'confirmed' ? 'status-live' : 'status-later'}">${status === 'pending' && expired ? '邀約已結束' : statusLabels[status]}</span>
            <h3>${escape(session.title)}</h3>
            ${session.quickMatch ? `<p class="incoming-name">${escape([session.partner.name, session.partner.department].filter(Boolean).join(' · '))}</p>` : ''}
            ${sessionFacts(session, null, true)}
            <div class="plan-actions">
              ${status === 'confirmed' && Date.now() >= Date.parse(session.start) ? button('標記完成', 'complete', { glyph: 'check', variant: 'primary', attrs }) : ''}
              ${(status === 'pending' || status === 'confirmed') && !expired ? button('取消預約', 'cancel', { attrs }) : ''}
              ${session.quickMatch ? button('檢舉', 'report', { glyph: 'flag', variant: 'text', attrs: `data-id="${escape(session.id)}"` }) : ''}
              ${session.quickMatch ? button('封鎖夥伴', 'block', { variant: 'text', attrs: `data-id="${escape(session.id)}"` }) : ''}
            </div>
          </article>`;
        }).join('') : '<p class="empty-state">加入一場邀約後，你可以在這裡查看進度。</p>'}
      </section>
      <section class="tool-panel plan-list" aria-labelledby="own-heading">
        <h2 id="own-heading">${icon('book')} 我發起的邀約</h2>
        ${own.length ? own.map(session => `
          <article class="plan-item"><span class="status-pill ${session.closed || hasEnded(session) ? 'status-later' : 'status-live'}">${session.closed ? '已關閉' : hasEnded(session) ? '已結束' : '招募中'}</span>
            <h3>${escape(session.title)}</h3>${sessionFacts(session, null, true)}
            ${session.closed || hasEnded(session) ? '' : `<div class="plan-actions">
              ${button('編輯邀約', 'edit-invite', { attrs: `data-id="${escape(session.id)}"` })}
              ${button('關閉邀約', 'close-invite', { attrs: `data-id="${escape(session.id)}"` })}
            </div>`}
          </article>`).join('') : '<p class="empty-state">你目前還沒有發起任何邀約。</p>'}
        ${button('發起邀約', 'publish', { glyph: 'plus', variant: 'primary' })}
      </section>
      <section class="tool-panel plan-list" aria-labelledby="incoming-heading">
        <h2 id="incoming-heading">${icon('users')} 收到的申請</h2>
        ${incoming.length ? incoming.map(item => {
          const session = own.find(candidate => candidate.id === item.sessionId);
          const open = session && !session.closed && !hasEnded(session);
          const attrs = `data-id="${escape(item.id)}"`;
          return `<article class="plan-item">
            <span class="status-pill ${item.status === 'confirmed' ? 'status-live' : 'status-later'}">${item.status === 'pending' ? (open ? '待你確認' : '邀約已結束') : statusLabels[item.status]}</span>
            <h3>${escape(item.title)}</h3><p class="incoming-name">${escape(item.name)}</p>
            <div class="plan-actions">
              ${open && item.status === 'pending' ? button('同意加入', 'confirm', { glyph: 'check', variant: 'primary', attrs }) : ''}
              ${open && item.status === 'pending' ? button('婉拒', 'reject', { attrs }) : ''}
              ${open && item.status === 'confirmed' ? button('取消共讀', 'cancel', { attrs }) : ''}
            </div>
          </article>`;
        }).join('') : '<p class="empty-state">有人申請加入你的邀約時，會出現在這裡。</p>'}
      </section>
    </div>`;
}

function showDialog(title, content, description = '') {
  dialog.innerHTML = `<header class="dialog-header"><div><h2 id="dialog-title">${title}</h2>${description ? `<p>${description}</p>` : ''}</div><button type="button" class="icon-button" data-action="close-dialog" aria-label="關閉">${icon('close')}</button></header>${content}`;
  if (!dialog.open) dialog.showModal();
  else dialog.querySelector('button').focus();
}

function showProfile() {
  const p = state.account;
  showDialog('我的帳號', `
    <form data-form="profile" class="dialog-form">
      <label class="field"><span>暱稱</span><input name="name" maxlength="40" autocomplete="nickname" value="${escape(p.name)}" required></label>
      <div class="field"><span>電子郵件</span><p class="field-value account-email">${escape(p.email)}</p></div>
      ${p.googleEmail ? `<div class="field"><span>已連結的${p.campusId ? '校園' : ' Google '}帳號</span><p class="field-value account-email">${escape(p.googleEmail)}</p></div>` : ''}
      <div class="field-grid">
        ${selectField('department', '科系', DEPARTMENTS, p.department)}
        ${selectField('region', '所在區域', campusRegionNames(p.campusId), p.region)}
        ${selectField('subject', '常讀科目', SUBJECTS, p.subject)}
        ${selectField('style', '共讀習慣', STYLES, p.style)}
      </div>
      <p class="account-error" data-request-error role="alert" hidden></p>
      <div class="form-actions"><button class="button button-primary" type="submit">儲存偏好</button>
      ${button('登出', 'logout')}</div>
    </form>`, '共讀偏好會用於推薦邀約。');
}

function showFilters() {
  showDialog('篩選邀約', `
    <form data-form="filters" class="dialog-form">
      <div class="field-grid">
        ${selectField('subject', '科目', SUBJECTS, filters.subject, '所有科目')}
        ${selectField('mode', '共讀方式', [['in-person', '實體'], ['online', '線上']], filters.mode, '不限方式')}
        ${selectField('region', '校園區域', campusRegionNames(selectedCampusId), filters.region, '所有區域')}
        ${selectField('style', '共讀習慣', STYLES, filters.style, '不限習慣')}
        ${selectField('department', '科系', DEPARTMENTS, filters.department, '所有科系')}
      </div>
      <p class="form-note" data-online-filter-note role="status" hidden>${onlineScopeNote}</p>
      <label class="check-field"><input type="checkbox" name="cross" ${filters.cross ? 'checked' : ''}> 排除同系學生</label>
      <div class="form-actions">${button('清除篩選', 'reset-filters')}<button class="button button-primary" type="submit">套用篩選</button></div>
    </form>`);
  updateFilterLocation(dialog.querySelector('[data-form="filters"]'));
}

function updateFilterLocation(form) {
  const online = form.elements.namedItem('mode').value === 'online';
  const region = form.elements.namedItem('region');
  if (online) region.value = '';
  region.disabled = online;
  region.closest('.field').hidden = online;
  form.querySelector('[data-online-filter-note]').hidden = !online;
}

function publishDraftKey(campusId) {
  return `${state.account.id}:${campusId}`;
}

function savePublishDraft(control) {
  const key = publishDraftKey(control.form.dataset.campusId);
  const draft = publishDrafts.get(key) ?? {};
  const edit = { [control.name]: control.value };
  if (['subject', 'mode', 'region'].includes(control.name)) {
    edit[`${control.name}Filter`] = publishFilter(control.name).context;
  }
  publishDrafts.set(key, { ...draft, ...edit });
}

function publishFilter(name) {
  if (view !== 'explore') return { value: '', context: '' };
  if (name === 'mode' && filters.region) {
    return { value: 'in-person', context: `in-person:${filters.region}` };
  }
  return { value: filters[name], context: filters[name] };
}

function publishChoice(name, draft, fallback) {
  const { value, context } = publishFilter(name);
  if (value && context !== draft[`${name}Filter`]) return value;
  return draft[name] ?? (value || fallback);
}

function showPublish(startNow = false) {
  const taipeiEpoch = Date.now() + 8 * 60 * minute;
  const earliest = new Date(taipeiEpoch).toISOString().slice(0, 16);
  const suggested = new Date(taipeiEpoch + 30 * minute).toISOString().slice(0, 16);
  const p = state.account;
  const campus = activeCampus();
  const regions = campusRegionNames(campus.id);
  const draft = publishDrafts.get(publishDraftKey(campus.id)) ?? {};
  const homeRegion = (p.campusId ?? DEFAULT_CAMPUS_ID) === campus.id ? p.region : '';
  const region = [publishChoice('region', draft, filters.region), homeRegion].find(value => regions.includes(value)) ?? regions[0];
  const subject = publishChoice('subject', draft, p.subject);
  const mode = publishChoice('mode', draft, 'in-person');
  const schedule = startNow ? 'now' : draft.schedule ?? 'now';
  const scheduled = schedule === 'later';
  showDialog('發起讀書邀約', `
    <form data-form="publish" data-campus-id="${escape(campus.id)}" class="dialog-form">
      <label class="field"><span>邀約標題</span><input name="title" required autofocus maxlength="42" placeholder="例如：圖書館一起複習微積分" value="${escape(draft.title ?? '')}"></label>
      <div class="field-grid">
        ${selectField('subject', '科目', SUBJECTS, subject)}
        ${selectField('style', '共讀習慣', STYLES, draft.style ?? p.style)}
        ${selectField('mode', '共讀方式', [['in-person', '實體'], ['online', '線上']], mode)}
        ${selectField('region', '校園區域', regions, region)}
        ${selectField('capacity', '人數上限', [['2', '2 人（一對一）'], ['3', '3 人'], ['4', '4 人'], ['5', '5 人'], ['6', '6 人']], draft.capacity ?? '2')}
        ${selectField('duration', '共讀長度', [['25', '25 分鐘'], ['50', '50 分鐘'], ['60', '60 分鐘'], ['90', '90 分鐘'], ['120', '120 分鐘']], draft.duration ?? '60')}
        ${selectField('schedule', '開始方式', [['now', '現在開始'], ['later', '預約時間']], schedule)}
        <label class="field"${scheduled ? '' : ' hidden'}><span>開始時間（台灣時間）</span><input name="start" type="datetime-local" min="${earliest}" value="${escape(draft.start ?? suggested)}"${scheduled ? ' required' : ' disabled'}></label>
      </div>
      <label class="field"><span>共讀說明（選填）</span><textarea name="note" rows="2" maxlength="180" placeholder="說明想一起讀什麼。">${escape(draft.note ?? '')}</textarea></label>
      <p class="form-note" data-campus-privacy>${icon('shield')} 實體邀約僅顯示概略校園區域。</p>
      <p class="form-note" data-publish-online-note role="status" hidden>${onlineScopeNote}</p>
      <p class="account-error" data-request-error role="alert" hidden></p>
      <button class="button button-primary" type="submit">${icon('plus')} 發布邀約</button>
    </form>`, `${escape(campus.name)} · ${escape(campus.area)}`);
  updatePublishLocation(dialog.querySelector('[data-form="publish"]'));
}

function updatePublishLocation(form) {
  const online = form.elements.namedItem('mode').value === 'online';
  const region = form.elements.namedItem('region');
  region.disabled = online;
  region.closest('.field').hidden = online;
  form.querySelector('[data-campus-privacy]').hidden = online;
  form.querySelector('[data-publish-online-note]').hidden = !online;
}

function showInviteEdit(id) {
  const session = getSession(id);
  if (!session || !isOwnSession(session) || session.closed || hasEnded(session)) return;
  const campus = getCampus(session.campusId ?? DEFAULT_CAMPUS_ID);
  showDialog('編輯讀書邀約', `
    <form data-form="edit-invite" data-id="${escape(id)}" class="dialog-form">
      <label class="field"><span>邀約標題</span><input name="title" required autofocus maxlength="42" value="${escape(session.title)}"></label>
      ${session.mode === 'online' ? '<p class="form-note">線上共讀</p>'
        : selectField('region', '校園區域', campusRegionNames(session.campusId), session.region)}
      <label class="field"><span>共讀說明（選填）</span><textarea name="note" rows="2" maxlength="180">${escape(session.note ?? '')}</textarea></label>
      <p class="account-error" data-request-error role="alert" hidden></p>
      <button class="button button-primary" type="submit">${icon('check')} 儲存修改</button>
    </form>`, `${escape(campus?.name ?? session.school)} · ${formatSlot(session)}`);
}

function getSession(id) {
  return state.sessions.find(session => session.id === id) ?? state.reservations[id]?.session;
}

function showDetails(id) {
  const session = getSession(id);
  if (!session) return;
  const reservation = state.reservations[id];
  const own = isOwnSession(session);
  const canJoin = canJoinSession(session);
  showDialog(escape(session.title), `
    <div class="detail-content">
      <div class="host">${avatar(session.initials, session.avatarColor)}<span><strong>${escape(session.host)}</strong><small>${escape(session.department)}</small></span></div>
      <div class="tags"><span>${escape(session.subject)}</span><span>${escape(session.style)}</span><span>${session.format === 'pair' ? '一對一' : '小團體'}</span></div>
      ${sessionFacts(session)}
      <p class="detail-capacity">${icon('users')} ${session.joined}／${session.capacity} 人</p>
      ${session.note ? `<p class="detail-note">${escape(session.note)}</p>` : ''}
      ${own ? '<p class="form-note">這是你發起的邀約。</p><a class="button button-secondary" href="#plans" data-view="plans">管理邀約</a>' : canJoin ? `<form data-form="join" data-id="${escape(id)}" class="dialog-form">
        <label class="check-field"><input type="checkbox" name="agree" required> 我確認可以參加這個時段。</label>
        <p class="account-error" data-request-error role="alert" hidden></p>
        <button class="button button-primary" type="submit">送出加入申請</button>
      </form>` : reservation ? `<a class="button button-secondary" href="#plans" data-view="plans">${statusLabels[reservation.status]}・查看我的預約</a>` : '<p class="form-note">這個邀約目前無法加入。</p>'}
      ${own ? '' : `<div class="detail-safety">${button('檢舉', 'report', { glyph: 'flag', variant: 'text', attrs: `data-id="${escape(id)}"` })}${button('封鎖夥伴', 'block', { variant: 'text', attrs: `data-id="${escape(id)}"` })}</div>`}
    </div>`);
}

function showSafety(id, action) {
  const session = getSession(id);
  if (!session || (!session.quickMatch && isOwnSession(session))) return;
  const report = action === 'report';
  const blockMessage = session.quickMatch ? `封鎖 ${escape(session.partner.name)} 後，你們將無法再配對。` : `封鎖後，${escape(session.host)} 的邀約會從探索頁隱藏。`;
  showDialog(report ? (session.quickMatch ? '檢舉共讀夥伴' : '檢舉邀約') : '封鎖夥伴', `
    <form class="dialog-form" data-form="${action}" data-id="${escape(id)}">
      ${report ? selectField('reason', '檢舉原因', ['不當內容', '可疑邀約', '騷擾或安全疑慮', '其他'], '不當內容') : `<p>${blockMessage}</p>`}
      <p class="account-error" data-request-error role="alert" hidden></p>
      <button class="button button-primary" type="submit">${report ? '送出檢舉' : '確認封鎖'}</button>
    </form>`, report ? '檢舉會交給管理員處理。' : '');
}

function readInviteEdits(form, data) {
  const title = String(data.get('title') ?? '').trim();
  if (!title) {
    const titleControl = form.elements.namedItem('title');
    titleControl.setCustomValidity('請輸入邀約標題。');
    titleControl.reportValidity();
    return null;
  }
  return { title, region: data.get('region') ?? '', note: String(data.get('note') ?? '').trim() };
}

async function handlePublish(form, data) {
  const edits = readInviteEdits(form, data);
  if (!edits) return;
  const scheduled = data.get('schedule') === 'later';
  const start = scheduled ? Date.parse(`${data.get('start') || ''}:00+08:00`) : Date.now();
  if (!Number.isFinite(start) || (scheduled && start <= Date.now())) {
    const control = form.elements.namedItem('start');
    control.setCustomValidity('請選擇未來的開始時間。');
    control.reportValidity();
    return;
  }
  const session = {
    ...edits, mode: data.get('mode'), campusId: form.dataset.campusId,
    subject: data.get('subject'), style: data.get('style'),
    capacity: Number(data.get('capacity')),
    start: new Date(start).toISOString(), end: new Date(start + Number(data.get('duration')) * minute).toISOString(),
  };
  if (!await mutateStudy('/study/sessions', session)) return;
  publishDrafts.delete(publishDraftKey(form.dataset.campusId));
  dialog.close();
  navigate('plans');
  toast('已發起讀書邀約。');
}

async function handleInviteEdit(form, data) {
  const edits = readInviteEdits(form, data);
  const id = form.dataset.id;
  if (!edits || !await mutateStudy(`/study/sessions/${encodeURIComponent(id)}/edit`, edits)) return;
  dialog.close();
  render();
  app.querySelector(`[data-action="edit-invite"][data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  toast('已更新讀書邀約。');
}

async function updateReservation(id, action) {
  const change = {
    confirm: ['confirmed', '已同意加入。'],
    complete: ['completed', '已記錄共讀完成。'],
    cancel: ['cancelled', '已取消預約。'],
    reject: ['cancelled', '已婉拒加入申請。'],
  }[action];
  if (!await mutateStudy(`/study/reservations/${encodeURIComponent(id)}`, { status: change[0] })) return;
  render();
  toast(change[1]);
}

async function runRequest(control, execute, errorNode) {
  if (activeRequest) return;
  activeRequest = true;
  if (control) control.disabled = true;
  if (errorNode) errorNode.hidden = true;
  try {
    await execute();
  } catch (error) {
    if (error.code === 'ACCOUNT_CHANGED' && !state.account) return;
    if (errorNode?.isConnected && !errorNode.closest('dialog:not([open])')) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
    } else {
      toast(error.message);
    }
  } finally {
    activeRequest = false;
    if (control) control.disabled = false;
  }
}

async function updateViewData() {
  const currentView = view;
  if (!state.account || needsGoogleLink() || !['plans', 'explore'].includes(view)) return;
  try {
    if (!await refreshStudy() || currentView !== view || dialog.open || activeRequest) return;
    const mainFocused = document.activeElement === app.querySelector('main');
    render();
    if (mainFocused) app.querySelector('main').focus({ preventScroll: true });
    syncFocus();
  } catch (error) {
    if (state.account && currentView === view) toast(error.message);
  }
}

async function bootstrap() {
  loading = true;
  loadError = '';
  render();
  try {
    const { account, adminSetup: canSetup, campusLogin: canUseCampus } = await api('/account');
    adminSetup = canSetup;
    campusLogin = canUseCampus;
    if (account) {
      bindAccount(account);
      if (!needsGoogleLink()) {
        await refreshStudy();
        syncFocus();
        if (campusNotice) {
          toast(campusNotice);
          campusNotice = '';
        }
      }
    }
  } catch (error) {
    loadError = error.message;
  } finally {
    loading = false;
    render();
    void checkMatch();
  }
}

document.addEventListener('click', event => {
  if (event.target.closest('.skip-link')) {
    event.preventDefault();
    app.querySelector('main').focus();
    return;
  }
  const nav = event.target.closest('[data-view]');
  if (nav && !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.button !== 0)) {
    event.preventDefault();
    if (activeRequest) return;
    if (dialog.open) dialog.close();
    navigate(nav.dataset.view);
    app.querySelector('main').focus({ preventScroll: true });
    void updateViewData();
    return;
  }

  const control = event.target.closest('[data-action]');
  if (!control || activeRequest) return;
  const { action, id, value } = control.dataset;
  switch (action) {
    case 'auth-mode':
      authMode = authMode === 'register' ? 'login' : 'register';
      render();
      app.querySelector('.account-form input').focus();
      break;
    case 'legacy-auth':
      legacyLogin = !legacyLogin;
      render();
      if (legacyLogin) app.querySelector('.account-form input').focus();
      else app.querySelector('[data-action="legacy-auth"]').focus();
      break;
    case 'retry-bootstrap':
      void bootstrap();
      break;
    case 'logout':
      void runRequest(control, async () => {
        await api('/auth/logout', { method: 'POST' });
        resetAccount();
        campusNotice = '';
        dialog.close();
        render();
      }, dialog.querySelector('[data-request-error]'));
      break;
    case 'refresh':
      void runRequest(control, async () => {
        if (!await refreshStudy()) return;
        render();
        app.querySelector('[data-action="refresh"]')?.focus({ preventScroll: true });
        syncFocus();
        toast('資料已更新。');
      });
      break;
    case 'match-command':
      void runRequest(control, () => value === 'stop-location'
        ? stopMatchLocation({ action: value, ticketId: id })
        : changeMatch({ action: value, ticketId: id }));
      break;
    case 'share-match-location':
      shareMatchLocation();
      break;
    case 'match-map':
      void showMatchDestination(value);
      break;
    case 'choose-match-cafe':
      void runRequest(control, async () => {
        await selectMatchCafe(value);
        if (match.cafe?.id === value) {
          toast(`共同目的地已更新為${match.cafe.name}。`);
          void showMatchDestination('cafe');
        }
      });
      break;
    case 'browse-upcoming':
      filters.timing = 'later';
      refreshResults();
      app.querySelector('[data-action="timing"][data-value="later"]').focus();
      break;
    case 'explore-pane':
      showExplorePane(explorePane === 'list' ? 'map' : 'list');
      break;
    case 'locate-explore': {
      showExplorePane('map');
      const viewport = locateCampusPosition(app);
      app.querySelector('.explore-toolbar').scrollIntoView({ block: 'start' });
      viewport?.focus({ preventScroll: true });
      break;
    }
    case 'campus-cafes':
      showExplorePane('map');
      if (showCampusCafes(app)) app.querySelector('.explore-toolbar').scrollIntoView({ block: 'start' });
      break;
    case 'timing':
      filters.timing = value;
      refreshResults();
      break;
    case 'remove-filter':
      removeFilter(value);
      break;
    case 'map-region':
      if (view !== 'explore') break;
      if (value && filters.mode === 'online') {
        toast(onlineScopeNote);
        break;
      }
      filters.region = filters.region === value ? '' : value;
      refreshResults();
      break;
    case 'reset-filters':
      filters = { ...initialFilters };
      if (dialog.open) dialog.close();
      refreshResults();
      if (!control.isConnected) app.querySelector('[data-action="filters"]').focus();
      break;
    case 'profile': showProfile(); break;
    case 'filters': showFilters(); break;
    case 'publish': showPublish(value === 'now'); break;
    case 'edit-invite': showInviteEdit(id); break;
    case 'details': showDetails(id); break;
    case 'block':
    case 'report': showSafety(id, action); break;
    case 'close-dialog': dialog.close(); break;
    case 'confirm':
    case 'complete':
    case 'cancel':
    case 'reject':
      void runRequest(control, () => updateReservation(id, action));
      break;
    case 'close-invite':
      void runRequest(control, async () => {
        if (!await mutateStudy(`/study/sessions/${encodeURIComponent(id)}/close`)) return;
        render();
        toast('已關閉讀書邀約。');
      });
      break;
  }
});

document.addEventListener('input', event => {
  const { target } = event;
  const action = target.form?.dataset.form;
  if (action === 'publish' || action === 'edit-invite') target.setCustomValidity('');
  if (action === 'publish' && !target.matches('select')) savePublishDraft(target);
});

document.addEventListener('change', event => {
  const { target } = event;
  if (target.form?.hasAttribute('data-match-form') && target.name === 'shareLocation') {
    matchAutoShare = target.checked;
    return;
  }
  if (target.form?.hasAttribute('data-match-form') && target.name === 'region') {
    matchRegion = target.value;
    return;
  }
  if (target.id === 'campus-select') {
    if (!activeRequest) switchCampus(target.value);
    else target.value = selectedCampusId;
    return;
  }
  if (target.id === 'sort') {
    filters.sort = target.value;
    refreshResults();
  }
  if (target.form?.dataset.form === 'filters' && target.name === 'mode') updateFilterLocation(target.form);
  if (target.form?.dataset.form !== 'publish') return;
  if (target.matches('select')) savePublishDraft(target);
  if (target.name === 'mode') updatePublishLocation(target.form);
  if (target.name === 'schedule') {
    const start = target.form.elements.namedItem('start');
    start.required = target.value === 'later';
    start.disabled = !start.required;
    start.closest('.field').hidden = start.disabled;
  }
});

app.addEventListener('submit', event => {
  const form = event.target;
  if (form.hasAttribute('data-match-form')) {
    event.preventDefault();
    if (activeRequest) return;
    const data = new FormData(form);
    matchAutoShare = data.has('shareLocation');
    const region = data.get('region');
    void runRequest(event.submitter, () => changeMatch({ action: 'start', campusId: selectedCampusId, region }), form.querySelector('[data-request-error]'));
    return;
  }
  if (form.hasAttribute('data-match-cafe')) {
    event.preventDefault();
    const cafeId = new FormData(form).get('cafeId');
    void runRequest(event.submitter, () => selectMatchCafe(cafeId), form.querySelector('[data-request-error]'));
    return;
  }
  const action = form.dataset.auth;
  if (!action) return;
  event.preventDefault();
  const credentials = Object.fromEntries(new FormData(form));
  void runRequest(event.submitter, async () => {
    const { account } = await api(`/auth/${action}`, { method: 'POST', data: credentials });
    bindAccount(account);
    campusNotice = '';
    try {
      if (!needsGoogleLink()) {
        await refreshStudy();
        syncFocus();
      }
    } catch (error) {
      loadError = error.message;
    }
    render();
    void checkMatch();
    app.querySelector('main').focus({ preventScroll: true });
  }, form.querySelector('[data-request-error]'));
});

dialog.addEventListener('submit', event => {
  event.preventDefault();
  if (activeRequest) return;
  const form = event.target;
  const data = new FormData(form);
  if (form.dataset.form === 'filters') {
    filters = { ...filters, ...Object.fromEntries(data), cross: data.has('cross') };
    if (filters.mode === 'online') filters.region = '';
    dialog.close();
    refreshResults();
    return;
  }
  void runRequest(event.submitter, () => submitDialog(form, data), form.querySelector('[data-request-error]'));
});

dialog.addEventListener('cancel', event => {
  if (activeRequest) event.preventDefault();
});

async function submitDialog(form, data) {
  const { id, form: action } = form.dataset;
  switch (form.dataset.form) {
    case 'profile': {
      const { account } = await api('/profile', { method: 'PATCH', data: Object.fromEntries(data) });
      state.account = account;
      dialog.close();
      render();
      app.querySelector('.profile-trigger').focus();
      toast('已儲存你的偏好。');
      break;
    }
    case 'publish':
      await handlePublish(form, data);
      break;
    case 'edit-invite':
      await handleInviteEdit(form, data);
      break;
    case 'join':
      if (!data.has('agree')) return;
      if (!await mutateStudy(`/study/sessions/${encodeURIComponent(id)}/join`)) return;
      dialog.close();
      navigate('plans');
      toast('已送出加入申請，等待對方確認。');
      break;
    case 'report':
    case 'block': {
      const quickMatch = getSession(id)?.quickMatch;
      if (!await mutateStudy(`/study/sessions/${encodeURIComponent(id)}/${action}`, { reason: data.get('reason') })) return;
      dialog.close();
      if (quickMatch) render();
      else refreshResults();
      toast(action === 'report' ? '已送出檢舉。' : quickMatch ? '已封鎖這位夥伴。' : '已隱藏該夥伴的邀約。');
      break;
    }
  }
}

window.addEventListener('hashchange', () => {
  const next = activeView();
  if (next === view) return;
  if (next === 'explore') explorePane = 'list';
  view = next;
  if (dialog.open) dialog.close();
  render();
  if (next === 'match') void checkMatch();
  else if (match.status === 'matched') scheduleMatchCheck();
  window.scrollTo(0, 0);
  void updateViewData();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !activeRequest && !loading) {
    void updateViewData();
    void checkMatch();
    scheduleLocationUpload();
  } else if (match.status === 'matched') {
    scheduleMatchCheck();
    clearTimeout(matchLocationUploadTimer);
  }
});

app.addEventListener('studymate:device-location', event => {
  if (view !== 'match' || match.status !== 'matched') return;
  const position = event.detail?.position;
  if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) return;
  matchDeviceFix = event.detail;
  if (matchLocationError) {
    matchLocationError = '';
    renderMatchLocationUpdate();
  }
  syncMatchMap();
  scheduleLocationUpload();
});

app.addEventListener('studymate:device-location-error', event => {
  if (view !== 'match' || (!matchLocationRequested && !liveMatchLocation(match.myLocationShare))) return;
  const denied = event.detail?.code === 1;
  matchLocationError = denied ? '請在瀏覽器允許定位後再試。' : '暫時無法取得定位，正在等待訊號。';
  if (denied) stopDeviceShare();
  renderMatchLocationUpdate();
});

function stopDeviceShare() {
  const needsStop = matchLocationRequested || liveMatchLocation(match.myLocationShare) || matchLocationUpload;
  matchDeviceFix = undefined;
  syncMatchMap();
  if (needsStop) void stopMatchLocation({ action: 'stop-location', ticketId: match.ticketId }).catch(error => toast(error.message));
}

app.addEventListener('studymate:device-location-stopped', () => {
  if (view === 'match' && match.status === 'matched') stopDeviceShare();
});

void bootstrap();
