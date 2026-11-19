import { icon } from './icons.mjs';
import { isLive, scoreSession } from './matching.mjs';
import { SCHOOL, REGIONS, SUBJECTS, STYLES, DEPARTMENTS, PLACES } from './sample-data.mjs';
import { createStudyTools } from './study-tools.mjs';
import { bindCampusMap, DEFAULT_MAP_CAMPUS, renderCampusMap, updateCampusMapSelection } from './campus-map.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toastNode = document.querySelector('#toast');
const minute = 60_000;
const timeZone = 'Asia/Taipei';
const dayFormat = new Intl.DateTimeFormat('zh-TW', { timeZone, month: 'numeric', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('zh-TW', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const initialFilters = { timing: 'all', subject: '', mode: '', region: '', style: '', department: '', cross: false, sort: 'score' };

let state = emptyState();
let filters = { ...initialFilters };
let cleanup = () => {};
let toastTimeout;
let view = activeView();
let authMode = 'login';
let campusLogin = false;
let legacyLogin = false;
let loading = true;
let loadError = '';
let adminSetup = false;
let activeRequest = false;
let studyVersion = 0;
let focusSync = null;
const navigation = [
  ['explore', 'compass', '找讀書夥伴'],
  ['plans', 'calendar', '我的預約'],
  ['focus', 'timer', '專注計時'],
  ['places', 'pin', '讀書空間'],
];
const campusMaps = new Map([['ncnu', DEFAULT_MAP_CAMPUS]]);
let campusNotice = '';
const entryUrl = new URL(window.location.href);
const campusNotices = new Map([
  ['school', '請選擇暨大學生的 Google 校園帳號。'],
  ['link', '這個信箱可能已有 StudyMate 帳號，請先用舊帳密登入，再連結校園帳號。'],
  ['account', '校園帳號未能連結，請確認目前登入的 StudyMate 帳號後重試。'],
  ['failed', '校園帳號登入未完成，請重新開始。'],
  ['busy', '校園登入目前較忙，請稍後再試。'],
  ['unavailable', '校園登入目前未開放，請稍後再試。'],
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
  state = { ...emptyState(), account, ...restoreTimer(account.id) };
  filters = { ...initialFilters };
  loadError = '';
}

function resetAccount() {
  state = emptyState();
  authMode = 'login';
  legacyLogin = false;
  studyVersion++;
  loadError = '';
}

function needsCampusLink() {
  return Boolean(campusLogin && state.account?.role === 'student' && !state.account.campusId);
}

function signedInCampus() {
  return campusMaps.get(state.account?.campusId) ?? DEFAULT_MAP_CAMPUS;
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

const studyTools = createStudyTools({ read: () => state, save: saveFocus, icons: icon, toast, places: PLACES, escape });

function activeView() {
  const hash = window.location.hash.slice(1);
  return ['plans', 'focus', 'places'].includes(hash) ? hash : 'explore';
}

function navigate(next, scroll = true) {
  if (window.location.hash !== `#${next}`) history.pushState(null, '', `#${next}`);
  view = next;
  render();
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
      <nav class="nav" aria-label="主要導覽">
        ${navigation.map(([key, glyph, label]) => `<a href="#${key}" data-view="${key}"${key === view ? ' aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></a>`).join('')}
      </nav>
      <div class="sidebar-campus">
        <span class="sidebar-campus-icon">${icon('shield')}</span>
        <div><strong>暨大校園</strong><small>位置僅顯示校園區域</small></div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <a class="brand mobile-brand" href="#explore" data-view="explore" aria-label="StudyMate 首頁">
          <img src="./assets/icon.svg" width="36" height="36" alt="">
          <strong>StudyMate<span>.</span></strong>
        </a>
        <span class="campus-label">${icon('pin')} ${escape(signedInCampus().name)}</span>
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
  if (loading || !state.account || needsCampusLink()) {
    app.innerHTML = renderAuth();
    return;
  }
  if (loadError) {
    app.innerHTML = renderShell(`<section class="empty-state"><h1>無法載入共讀資料</h1><p>${escape(loadError)}</p>${button('重新整理資料', 'refresh')}</section>`);
    return;
  }
  const content = view === 'explore' ? renderExplore() : view === 'plans' ? renderPlans() : studyTools.render(view);
  app.innerHTML = renderShell(content);
  cleanup = view === 'explore' ? bindCampusMap(app) : studyTools.bind(app.querySelector('main'), view);
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

function campusEntry() {
  const notice = campusNotice ? `<p class="account-error campus-entry-notice" role="alert">${escape(campusNotice)}</p>` : '';
  if (needsCampusLink()) {
    const account = state.account;
    return `<h2>連結學校帳號</h2>
      <p class="account-description">連結後會開啟暨大周邊地圖，原本的邀約與預約會留在此帳號。</p>
      <p class="account-email campus-linked-account">${escape(account.email)}</p>
      ${notice}
      <a class="button button-primary account-submit" href="/api/auth/campus/start?intent=link&amp;account=${encodeURIComponent(account.id)}">${icon('shield')} 連結暨大 Google 帳號</a>
      <div class="account-switch">${button('登出', 'logout', { variant: 'text' })}</div>`;
  }
  return `<h2>使用學校帳號登入</h2>
    <p class="account-description">使用暨大學生 Google 帳號，登入後直接開啟校園周邊地圖。</p>
    ${notice}
    <a class="button button-primary account-submit" href="/api/auth/campus/start">${icon('shield')} 使用暨大 Google 帳號登入</a>
    <div class="account-switch">${button(legacyLogin ? '收起舊帳號表單' : '連結舊 StudyMate 帳號', 'legacy-auth', { variant: 'text' })}</div>
    ${legacyLogin ? passwordEntry(false, '登入並連結校園帳號') : ''}`;
}

function renderAuth() {
  const register = authMode === 'register';
  return `
    <main class="account-layout" id="main-content" tabindex="-1">
      <section class="account-welcome" aria-labelledby="welcome-heading">
        <div class="account-brand">
          <img src="./assets/icon.svg" width="46" height="46" alt="">
          <span><strong>StudyMate<span>.</span></strong><small>校園共讀</small></span>
        </div>
        <div class="account-welcome-copy">
          <p class="hero-campus">${icon('book')} ${SCHOOL}</p>
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
            ${campusLogin ? campusEntry() : `
            <h2>${register ? '建立共讀帳號' : '歡迎回來'}</h2>
            <p class="account-description">${register ? '建立帳號後，就可以發起或加入共讀。' : '使用電子郵件登入 StudyMate。'}</p>
            ${campusNotice ? `<p class="account-error campus-entry-notice" role="alert">${escape(campusNotice)}</p>` : ''}
            ${passwordEntry(register, register ? '註冊並登入' : '登入')}
            <div class="account-switch"><span>${register ? '已經有帳號？' : '第一次使用？'}</span>${button(register ? '我要登入' : '建立帳號', 'auth-mode', { variant: 'text' })}</div>`}
            <a class="account-setup-link" href="/admin">${adminSetup ? '管理員初始設定' : '管理員登入'}</a>
          </div>`}
      </section>
    </main>`;
}

function renderExplore() {
  const results = matchingSessions();
  const pending = Object.values(state.reservations).filter(item => item.status === 'pending' && !hasEnded(item.session)).length;
  const upcoming = Object.values(state.reservations).filter(item => item.status === 'confirmed' && !hasEnded(item.session)).length;
  return `
    ${renderCampusMap({
      campus: signedInCampus(), selectedRegion: filters.region, invitations: state.sessions,
      actions: button('即時找夥伴', 'find-now', { glyph: 'bolt', variant: 'secondary' })
        + button('發起邀約', 'publish', { glyph: 'plus', variant: 'primary' }),
    })}
    <div class="dashboard-grid">
      <section class="discovery" aria-labelledby="discovery-title">
        <header class="section-heading heading-with-action" id="discovery-heading">
          <div><h2 id="discovery-title" tabindex="-1">探索讀書夥伴</h2>
          <p>依照科目、時間和校園區域，找到適合你的共讀邀約。</p></div>
          ${button('重新整理', 'refresh', { glyph: 'rotate', variant: 'text', attrs: 'aria-label="重新整理邀約"' })}
        </header>
        <div class="filter-bar">
          <div class="segmented" role="group" aria-label="依時段篩選">
            ${[['all', '全部'], ['now', '正在揪團'], ['later', '可預約']].map(([key, label]) => `<button type="button" data-action="timing" data-value="${key}" aria-pressed="${filters.timing === key}">${key === 'now' ? '<span class="dot"></span>' : ''}${label}</button>`).join('')}
          </div>
          ${button('篩選', 'filters', { glyph: 'sliders' })}
        </div>
        <div class="results-line"><span id="result-count" aria-live="polite">${escape(resultCount(results))}</span><label class="sort-control"><span class="sr-only">排序</span><select id="sort">${selectOptions([['score', '媒合度優先'], ['distance', '區域距離優先'], ['time', '時間優先']], filters.sort)}</select>${icon('chevron')}</label></div>
        <div id="results" class="session-grid">${renderResults(results)}</div>
      </section>
      <aside class="dashboard-aside" aria-label="讀書小工具">
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

function hasEnded(session, now = Date.now()) {
  return Date.parse(session.end) <= now;
}

function matchingSessions() {
  const now = Date.now();
  const preferences = { ...state.account, start: now, end: now + 90 * minute };
  for (const key of ['region', 'subject', 'style']) {
    if (filters[key]) preferences[key] = filters[key];
  }
  return state.sessions.filter(session => (
    !session.closed && !hasEnded(session, now)
    && (!filters.subject || session.subject === filters.subject)
    && (!filters.mode || session.mode === filters.mode)
    && (!filters.region || session.region === filters.region)
    && (!filters.style || session.style === filters.style)
    && (!filters.department || session.department === filters.department)
    && (!filters.cross || session.department !== state.account.department)
    && (filters.timing !== 'now' || isLive(session, now))
    && (filters.timing !== 'later' || Date.parse(session.start) > now)
  )).map(session => ({ session, ...scoreSession(session, preferences) })).sort((a, b) => {
    if (filters.sort === 'distance') return (a.distance ?? Infinity) - (b.distance ?? Infinity) || b.score - a.score;
    if (filters.sort === 'time') return Date.parse(a.session.start) - Date.parse(b.session.start);
    return b.score - a.score;
  });
}

function renderResults(results) {
  return results.length ? results.map(renderCard).join('') : `
    <div class="empty-state"><span class="tile-icon">${icon('search')}</span>
    ${state.sessions.some(session => !session.closed && !hasEnded(session))
      ? `<h3>目前沒有符合條件的邀約</h3><p>可以放寬條件，或自己發起共讀。</p>${button('清除篩選', 'reset-filters')}`
      : `<h3>目前沒有共讀邀約</h3><p>選個時段和讀書方式，讓其他人可以加入。</p>${button('發起第一場邀約', 'publish', { glyph: 'plus', variant: 'primary' })}`}
    </div>`;
}

function resultCount(results) {
  return `${filters.region ? `${filters.region} · ` : ''}${results.length} 個邀約`;
}

function refreshResults() {
  const container = document.querySelector('#results');
  if (!container) return;
  const results = matchingSessions();
  container.innerHTML = renderResults(results);
  document.querySelector('#result-count').textContent = resultCount(results);
  updateCampusMapSelection(app, filters.region);
  for (const control of app.querySelectorAll('[data-action="timing"]')) {
    control.setAttribute('aria-pressed', String(control.dataset.value === filters.timing));
  }
  document.querySelector('#sort').value = filters.sort;
}

function formatSlot(session) {
  const start = new Date(session.start);
  const end = new Date(session.end);
  const day = dayFormat.format(start);
  const prefix = day === dayFormat.format(Date.now()) ? '今天' : day;
  const endDay = dayFormat.format(end) === day ? '' : `${dayFormat.format(end)} `;
  return `${prefix} ${timeFormat.format(start)}–${endDay}${timeFormat.format(end)}`;
}

function sessionFacts(session, distance) {
  const where = session.mode === 'online' ? '線上共讀' : session.region;
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

function renderCard({ session, score, distance }) {
  const live = isLive(session);
  return `
    <article class="session-card">
      <div class="card-top"><span class="status-pill ${live ? 'status-live' : 'status-later'}"><span class="dot"></span>${live ? '正在揪團' : '開放預約'}</span>
        ${isOwnSession(session) ? '<span class="score">我的邀約</span>' : `<span class="score" title="參考科目、讀書習慣、時段與概略區域">${icon('spark')} ${score}% 媒合度</span>`}
      </div>
      <h3>${escape(session.title)}</h3>
      <div class="tags"><span>${escape(session.subject)}</span><span>${escape(session.style)}</span><span>${session.format === 'pair' ? '一對一' : '小團體'}</span></div>
      ${sessionFacts(session, distance)}
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
            <h3>${escape(session.title)}</h3>${sessionFacts(session)}
            <div class="plan-actions">
              ${status === 'confirmed' && Date.now() >= Date.parse(session.start) ? button('標記完成', 'complete', { glyph: 'check', variant: 'primary', attrs }) : ''}
              ${(status === 'pending' || status === 'confirmed') && !expired ? button('取消預約', 'cancel', { attrs }) : ''}
            </div>
          </article>`;
        }).join('') : '<p class="empty-state">加入一場邀約後，你可以在這裡查看進度。</p>'}
      </section>
      <section class="tool-panel plan-list" aria-labelledby="own-heading">
        <h2 id="own-heading">${icon('book')} 我發起的邀約</h2>
        ${own.length ? own.map(session => `
          <article class="plan-item"><span class="status-pill ${session.closed || hasEnded(session) ? 'status-later' : 'status-live'}">${session.closed ? '已關閉' : hasEnded(session) ? '已結束' : '招募中'}</span>
            <h3>${escape(session.title)}</h3>${sessionFacts(session)}
            ${session.closed || hasEnded(session) ? '' : button('關閉邀約', 'close-invite', { attrs: `data-id="${escape(session.id)}"` })}
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
      ${p.campusEmail ? `<div class="field"><span>已連結的校園帳號</span><p class="field-value account-email">${escape(p.campusEmail)}</p></div>` : ''}
      <div class="field-grid">
        ${selectField('department', '科系', DEPARTMENTS, p.department)}
        ${selectField('region', '所在區域', REGIONS, p.region)}
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
        ${selectField('region', '校園區域', REGIONS, filters.region, '所有區域')}
        ${selectField('style', '共讀習慣', STYLES, filters.style, '不限習慣')}
        ${selectField('department', '科系', DEPARTMENTS, filters.department, '所有科系')}
      </div>
      <label class="check-field"><input type="checkbox" name="cross" ${filters.cross ? 'checked' : ''}> 排除同系學生</label>
      <div class="form-actions">${button('清除篩選', 'reset-filters')}<button class="button button-primary" type="submit">套用篩選</button></div>
    </form>`);
}

function showPublish() {
  const taipeiEpoch = Date.now() + 8 * 60 * minute;
  const earliest = new Date(taipeiEpoch).toISOString().slice(0, 16);
  const suggested = new Date(taipeiEpoch + 30 * minute).toISOString().slice(0, 16);
  const p = state.account;
  showDialog('發起讀書邀約', `
    <form data-form="publish" class="dialog-form">
      <label class="field"><span>邀約標題</span><input name="title" required maxlength="42" placeholder="例如：圖書館一起複習微積分"></label>
      <div class="field-grid">
        ${selectField('subject', '科目', SUBJECTS, p.subject)}
        ${selectField('style', '共讀習慣', STYLES, p.style)}
        ${selectField('mode', '共讀方式', [['in-person', '實體'], ['online', '線上']], 'in-person')}
        ${selectField('region', '校園區域', REGIONS, p.region)}
        ${selectField('capacity', '人數上限', [['2', '2 人（一對一）'], ['3', '3 人'], ['4', '4 人'], ['5', '5 人'], ['6', '6 人']], '2')}
        ${selectField('duration', '共讀長度', [['25', '25 分鐘'], ['50', '50 分鐘'], ['60', '60 分鐘'], ['90', '90 分鐘'], ['120', '120 分鐘']], '60')}
        ${selectField('schedule', '開始方式', [['now', '現在開始'], ['later', '預約時間']], 'now')}
        <label class="field" hidden><span>開始時間（台灣時間）</span><input name="start" type="datetime-local" min="${earliest}" value="${suggested}" disabled></label>
      </div>
      <label class="field"><span>共讀說明（選填）</span><textarea name="note" rows="2" maxlength="180" placeholder="說明想一起讀什麼。"></textarea></label>
      <p class="form-note" data-campus-privacy>${icon('shield')} 實體邀約僅顯示概略校園區域。</p>
      <p class="account-error" data-request-error role="alert" hidden></p>
      <button class="button button-primary" type="submit">${icon('plus')} 發布邀約</button>
    </form>`);
}

function getSession(id) {
  return state.sessions.find(session => session.id === id);
}

function showDetails(id) {
  const session = getSession(id);
  if (!session) return;
  const reservation = state.reservations[id];
  const own = isOwnSession(session);
  const canJoin = !own && !hasEnded(session) && !session.closed && session.joined < session.capacity && (!reservation || reservation.status === 'cancelled');
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
  if (!session || isOwnSession(session)) return;
  const report = action === 'report';
  showDialog(report ? '檢舉邀約' : '封鎖夥伴', `
    <form class="dialog-form" data-form="${action}" data-id="${escape(id)}">
      ${report ? selectField('reason', '檢舉原因', ['不當內容', '可疑邀約', '騷擾或安全疑慮', '其他'], '不當內容') : `<p>封鎖後，${escape(session.host)} 的邀約會從探索頁隱藏。</p>`}
      <p class="account-error" data-request-error role="alert" hidden></p>
      <button class="button button-primary" type="submit">${report ? '送出檢舉' : '確認封鎖'}</button>
    </form>`, report ? '檢舉會交給管理員處理。' : '');
}

async function handlePublish(form, data) {
  const titleControl = form.elements.namedItem('title');
  const title = String(data.get('title')).trim();
  const scheduled = data.get('schedule') === 'later';
  const start = scheduled ? Date.parse(`${data.get('start') || ''}:00+08:00`) : Date.now();
  if (!title) {
    titleControl.setCustomValidity('請輸入邀約標題。');
    titleControl.reportValidity();
    return;
  }
  if (!Number.isFinite(start) || (scheduled && start <= Date.now())) {
    const control = form.elements.namedItem('start');
    control.setCustomValidity('請選擇未來的開始時間。');
    control.reportValidity();
    return;
  }
  const mode = data.get('mode');
  const session = {
    title, mode, region: mode === 'online' ? '' : data.get('region'),
    subject: data.get('subject'), style: data.get('style'),
    capacity: Number(data.get('capacity')),
    start: new Date(start).toISOString(), end: new Date(start + Number(data.get('duration')) * minute).toISOString(),
    note: String(data.get('note')).trim(),
  };
  if (!await mutateStudy('/study/sessions', session)) return;
  dialog.close();
  navigate('plans');
  toast('已發起讀書邀約。');
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
  if (!state.account || needsCampusLink() || !['plans', 'explore'].includes(view)) return;
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
      if (!needsCampusLink()) {
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
    case 'find-now':
      filters.timing = 'now';
      refreshResults();
      document.querySelector('#discovery-title').focus();
      document.querySelector('#discovery-heading').scrollIntoView({ block: 'start' });
      break;
    case 'timing':
      filters.timing = value;
      refreshResults();
      break;
    case 'map-region':
      filters.region = filters.region === value ? '' : value;
      if (filters.region && filters.mode === 'online') filters.mode = '';
      refreshResults();
      break;
    case 'reset-filters':
      filters = { ...initialFilters };
      if (dialog.open) dialog.close();
      refreshResults();
      break;
    case 'profile': showProfile(); break;
    case 'filters': showFilters(); break;
    case 'publish': showPublish(); break;
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
  if (target.form?.dataset.form === 'publish') target.setCustomValidity('');
});

document.addEventListener('change', event => {
  const { target } = event;
  if (target.id === 'sort') {
    filters.sort = target.value;
    refreshResults();
  }
  if (target.form?.dataset.form !== 'publish') return;
  if (target.name === 'mode') {
    const online = target.value === 'online';
    const region = target.form.elements.namedItem('region');
    region.disabled = online;
    region.closest('.field').hidden = online;
    target.form.querySelector('[data-campus-privacy]').hidden = online;
  }
  if (target.name === 'schedule') {
    const start = target.form.elements.namedItem('start');
    start.required = target.value === 'later';
    start.disabled = !start.required;
    start.closest('.field').hidden = start.disabled;
  }
});

app.addEventListener('submit', event => {
  const form = event.target;
  const action = form.dataset.auth;
  if (!action) return;
  event.preventDefault();
  const credentials = Object.fromEntries(new FormData(form));
  void runRequest(event.submitter, async () => {
    const { account } = await api(`/auth/${action}`, { method: 'POST', data: credentials });
    bindAccount(account);
    campusNotice = '';
    try {
      if (!needsCampusLink()) {
        await refreshStudy();
        syncFocus();
      }
    } catch (error) {
      loadError = error.message;
    }
    render();
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
    case 'join':
      if (!data.has('agree')) return;
      if (!await mutateStudy(`/study/sessions/${encodeURIComponent(id)}/join`)) return;
      dialog.close();
      navigate('plans');
      toast('已送出加入申請，等待對方確認。');
      break;
    case 'report':
    case 'block':
      if (!await mutateStudy(`/study/sessions/${encodeURIComponent(id)}/${action}`, { reason: data.get('reason') })) return;
      dialog.close();
      refreshResults();
      toast(action === 'report' ? '已送出檢舉。' : '已隱藏該夥伴的邀約。');
      break;
  }
}

window.addEventListener('hashchange', () => {
  const next = activeView();
  if (next === view) return;
  view = next;
  if (dialog.open) dialog.close();
  render();
  window.scrollTo(0, 0);
  void updateViewData();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !activeRequest && !loading) void updateViewData();
});

void bootstrap();
