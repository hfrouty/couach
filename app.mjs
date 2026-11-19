import { icon } from './icons.mjs';
import { isLive, scoreSession } from './matching.mjs';
import { SCHOOL, REGIONS, SUBJECTS, STYLES, DEPARTMENTS, PLACES, makeSampleSessions } from './sample-data.mjs';
import { createStudyTools } from './study-tools.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toastNode = document.querySelector('#toast');
const storageKey = 'studymate:v1';
const minute = 60_000;
const timeZone = 'Asia/Taipei';
const dayFormat = new Intl.DateTimeFormat('zh-TW', { timeZone, month: 'numeric', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('zh-TW', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const defaultProfile = {
  name: '', department: DEPARTMENTS[0], region: REGIONS[0], subject: SUBJECTS[0], style: STYLES[0],
};
const initialFilters = { timing: 'all', subject: '', mode: '', region: '', style: '', department: '', cross: false, sort: 'score' };

let state = load();
let filters = { ...initialFilters };
let cleanup = () => {};
let toastTimeout;
let view = activeView();
const demoStart = getDemoStart();
const samples = makeSampleSessions(new Date(demoStart)).map(session => ({
  ...session,
  id: `${session.id}-${demoStart}`,
}));
const navigation = [
  ['explore', 'compass', '找讀書夥伴'],
  ['plans', 'calendar', '我的預約'],
  ['focus', 'timer', '專注計時'],
  ['places', 'pin', '讀書空間'],
];

function load() {
  let existing;
  try {
    existing = JSON.parse(localStorage.getItem(storageKey));
  } catch {
    existing = null;
  }
  return {
    sessions: [], reservations: {}, blocked: [], reports: [], focusLog: [],
    ...existing,
    profile: { ...defaultProfile, ...existing?.profile },
  };
}

function save(partial) {
  state = { ...state, ...partial };
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    toast('瀏覽器目前無法儲存，資料會在關閉本頁後清除。');
  }
}

function getDemoStart() {
  const now = Date.now();
  if (state.demoStart <= now && now - state.demoStart < 60 * minute) return state.demoStart;
  save({ demoStart: now });
  return now;
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

const studyTools = createStudyTools({ read: () => state, save, icons: icon, toast, places: PLACES, escape });

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
        <div><strong>暨大示範校園</strong><small>位置僅顯示校園區域</small></div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <a class="brand mobile-brand" href="#explore" data-view="explore" aria-label="StudyMate 首頁">
          <img src="./assets/icon.svg" width="36" height="36" alt="">
          <strong>StudyMate<span>.</span></strong>
        </a>
        <span class="campus-label">${icon('pin')} ${SCHOOL}</span>
        <div class="top-actions">
          <span class="demo-label">示範模式</span>
          <button type="button" class="profile-trigger" data-action="profile" aria-label="我的偏好">${avatar(state.profile.name.slice(0, 1) || '訪')}<span>${escape(state.profile.name || '訪客')}</span>${icon('chevron')}</button>
        </div>
      </header>
      <main id="main-content" class="main-content" tabindex="-1">${content}</main>
    </div>`;
}

function render() {
  cleanup();
  const content = view === 'explore' ? renderExplore() : view === 'plans' ? renderPlans() : studyTools.render(view);
  app.innerHTML = renderShell(content);
  cleanup = studyTools.bind(app.querySelector('main'), view);
}

function renderExplore() {
  const results = matchingSessions();
  const pending = Object.values(state.reservations).filter(item => item.status === 'pending' && !hasEnded(item.session)).length;
  const upcoming = Object.values(state.reservations).filter(item => item.status === 'confirmed' && !hasEnded(item.session)).length;
  return `
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-content">
        <p class="hero-campus">${icon('book')} 暨大校園共讀</p>
        <h1 id="hero-title">找個夥伴，<br><em>一起把書讀完。</em></h1>
        <p class="hero-description">從圖書館到線上自習室，找到和你同一個節奏的人。</p>
        <div class="hero-actions">
          ${button('即時找夥伴', 'find-now', { glyph: 'bolt', variant: 'lime' })}
          ${button('發起邀約', 'publish', { glyph: 'plus', variant: 'glass' })}
        </div>
      </div>
    </section>
    <div class="dashboard-grid">
      <section class="discovery" aria-labelledby="discovery-title">
        <header class="section-heading" id="discovery-heading">
          <h2 id="discovery-title" tabindex="-1">探索讀書夥伴</h2>
          <p>依照科目、時間和校園區域，找到適合你的共讀邀約。</p>
        </header>
        <div class="filter-bar">
          <div class="segmented" role="group" aria-label="依時段篩選">
            ${[['all', '全部'], ['now', '正在揪團'], ['later', '可預約']].map(([key, label]) => `<button type="button" data-action="timing" data-value="${key}" aria-pressed="${filters.timing === key}">${key === 'now' ? '<span class="dot"></span>' : ''}${label}</button>`).join('')}
          </div>
          ${button('篩選', 'filters', { glyph: 'sliders' })}
        </div>
        <div class="results-line"><span id="result-count" aria-live="polite">${results.length} 個邀約</span><label class="sort-control"><span class="sr-only">排序</span><select id="sort">${selectOptions([['score', '媒合度優先'], ['distance', '區域距離優先'], ['time', '時間優先']], filters.sort)}</select>${icon('chevron')}</label></div>
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
  const preferences = { ...state.profile, start: now, end: now + 90 * minute };
  for (const key of ['region', 'subject', 'style']) {
    if (filters[key]) preferences[key] = filters[key];
  }
  return [...samples, ...state.sessions].filter(session => (
    !session.closed && !hasEnded(session, now) && !state.blocked.includes(session.host)
    && (!filters.subject || session.subject === filters.subject)
    && (!filters.mode || session.mode === filters.mode)
    && (!filters.region || session.region === filters.region)
    && (!filters.style || session.style === filters.style)
    && (!filters.department || session.department === filters.department)
    && (!filters.cross || session.department !== state.profile.department)
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
    <div class="empty-state"><span class="tile-icon">${icon('search')}</span><h3>目前沒有符合條件的邀約</h3>
    <p>可以放寬篩選條件，或自己發起一場共讀。</p>${button('清除篩選', 'reset-filters')}</div>`;
}

function refreshResults() {
  const container = document.querySelector('#results');
  if (!container) return;
  const results = matchingSessions();
  container.innerHTML = renderResults(results);
  document.querySelector('#result-count').textContent = `${results.length} 個邀約`;
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

function renderCard({ session, score, distance }) {
  const live = isLive(session);
  return `
    <article class="session-card">
      <div class="card-top"><span class="status-pill ${live ? 'status-live' : 'status-later'}"><span class="dot"></span>${live ? '正在揪團' : '開放預約'}</span>
        ${session.own ? '<span class="score">我的邀約</span>' : `<span class="score" title="參考科目、讀書習慣、時段與概略區域">${icon('spark')} ${score}% 媒合度</span>`}
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
  return `
    <header class="tool-heading"><h1>我的預約</h1><p>查看你的加入申請、已確認的共讀場次，以及自己發起的邀約。</p></header>
    <div class="plans-grid">
      <section class="tool-panel plan-list" aria-labelledby="reservation-heading">
        <h2 id="reservation-heading">${icon('calendar')} 我的共讀</h2>
        ${reservations.length ? reservations.map(item => {
          const { session, status } = item;
          const expired = hasEnded(session);
          return `<article class="plan-item">
            <span class="status-pill ${status === 'confirmed' ? 'status-live' : 'status-later'}">${status === 'pending' && expired ? '邀約已結束' : statusLabels[status]}</span>
            <h3>${escape(session.title)}</h3>${sessionFacts(session)}
            <div class="plan-actions">
              ${status === 'pending' && !expired && session.isSample ? button('模擬對方確認', 'confirm', { variant: 'primary', attrs: `data-id="${escape(session.id)}"` }) : ''}
              ${status === 'confirmed' && Date.now() >= Date.parse(session.start) ? button('標記完成', 'complete', { glyph: 'check', variant: 'primary', attrs: `data-id="${escape(session.id)}"` }) : ''}
              ${(status === 'pending' || status === 'confirmed') && !expired ? button('取消預約', 'cancel', { attrs: `data-id="${escape(session.id)}"` }) : ''}
            </div>
          </article>`;
        }).join('') : '<p class="empty-state">加入一場邀約後，你可以在這裡查看進度。</p>'}
      </section>
      <section class="tool-panel plan-list" aria-labelledby="own-heading">
        <h2 id="own-heading">${icon('book')} 我發起的邀約</h2>
        ${state.sessions.length ? state.sessions.map(session => `
          <article class="plan-item"><span class="status-pill ${session.closed || hasEnded(session) ? 'status-later' : 'status-live'}">${session.closed ? '已關閉' : hasEnded(session) ? '已結束' : '招募中'}</span>
            <h3>${escape(session.title)}</h3>${sessionFacts(session)}
            ${session.closed || hasEnded(session) ? '' : button('關閉邀約', 'close-invite', { attrs: `data-id="${escape(session.id)}"` })}
          </article>`).join('') : '<p class="empty-state">你目前還沒有發起任何邀約。</p>'}
        ${button('發起邀約', 'publish', { glyph: 'plus', variant: 'primary' })}
      </section>
    </div>`;
}

function showDialog(title, content, description = '') {
  dialog.innerHTML = `<header class="dialog-header"><div><h2 id="dialog-title">${title}</h2>${description ? `<p>${description}</p>` : ''}</div><button type="button" class="icon-button" data-action="close-dialog" aria-label="關閉">${icon('close')}</button></header>${content}`;
  if (!dialog.open) dialog.showModal();
  else dialog.querySelector('button').focus();
}

function showProfile() {
  const p = state.profile;
  showDialog('我的偏好', `
    <form data-form="profile" class="dialog-form">
      <label class="field"><span>暱稱</span><input name="name" maxlength="20" placeholder="訪客" value="${escape(p.name)}"></label>
      <div class="field"><span>示範校園</span><p class="field-value">${SCHOOL}</p></div>
      <div class="field-grid">
        ${selectField('department', '科系', DEPARTMENTS, p.department)}
        ${selectField('region', '所在區域', REGIONS, p.region)}
        ${selectField('subject', '常讀科目', SUBJECTS, p.subject)}
        ${selectField('style', '共讀習慣', STYLES, p.style)}
      </div>
      <button class="button button-primary" type="submit">儲存偏好</button>
    </form>`, '這些偏好會用於推薦邀約，並儲存在這個瀏覽器。');
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
  const p = state.profile;
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
      <p class="form-note">${icon('shield')} 實體邀約僅顯示概略校園區域。</p>
      <button class="button button-primary" type="submit">${icon('plus')} 發布邀約</button>
    </form>`, '這筆示範邀約會儲存在這個瀏覽器。');
}

function getSession(id) {
  return [...samples, ...state.sessions].find(session => session.id === id);
}

function showDetails(id) {
  const session = getSession(id);
  if (!session) return;
  const reservation = state.reservations[id];
  const canJoin = !session.own && !hasEnded(session) && !session.closed && session.joined < session.capacity && (!reservation || reservation.status === 'cancelled');
  showDialog(escape(session.title), `
    <div class="detail-content">
      <div class="host">${avatar(session.initials, session.avatarColor)}<span><strong>${escape(session.host)}</strong><small>${escape(session.department)}${session.isSample ? ' · 示範夥伴' : ''}</small></span></div>
      <div class="tags"><span>${escape(session.subject)}</span><span>${escape(session.style)}</span><span>${session.format === 'pair' ? '一對一' : '小團體'}</span></div>
      ${sessionFacts(session)}
      <p class="detail-capacity">${icon('users')} ${session.joined}／${session.capacity} 人</p>
      ${session.note ? `<p class="detail-note">${escape(session.note)}</p>` : ''}
      ${canJoin ? `<form data-form="join" data-id="${escape(id)}" class="dialog-form">
        <label class="check-field"><input type="checkbox" name="agree" required> 我確認可以參加這個時段。</label>
        <button class="button button-primary" type="submit">送出加入申請</button>
      </form>` : reservation ? `<a class="button button-secondary" href="#plans" data-view="plans">${statusLabels[reservation.status]}・查看我的預約</a>` : `<p class="form-note">${session.own ? '這是你發起的邀約。' : '這個邀約目前無法加入。'}</p>`}
      ${session.own ? '' : `<div class="detail-safety">${button('檢舉', 'report', { glyph: 'flag', variant: 'text', attrs: `data-id="${escape(id)}"` })}${button('封鎖夥伴', 'block', { variant: 'text', attrs: `data-id="${escape(id)}"` })}</div>`}
    </div>`);
}

function showSafety(id, action) {
  const session = getSession(id);
  if (!session || session.own) return;
  const report = action === 'report';
  showDialog(report ? '檢舉邀約' : '封鎖夥伴', `
    <form class="dialog-form" data-form="${action}" data-id="${escape(id)}">
      ${report ? selectField('reason', '檢舉原因', ['不當內容', '可疑邀約', '騷擾或安全疑慮', '其他'], '不當內容') : `<p>封鎖後，${escape(session.host)} 的邀約會從探索頁隱藏。</p>`}
      <button class="button button-primary" type="submit">${report ? '儲存檢舉' : '確認封鎖'}</button>
    </form>`, '這項操作只會儲存在目前瀏覽器。');
}

function handlePublish(form, data) {
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
  const { name, department } = state.profile;
  const capacity = Number(data.get('capacity'));
  const mode = data.get('mode');
  const session = {
    id: crypto.randomUUID(), title, school: SCHOOL, department, mode, own: true,
    region: mode === 'online' ? '' : data.get('region'),
    subject: data.get('subject'), style: data.get('style'),
    format: capacity === 2 ? 'pair' : 'group', capacity, joined: 1,
    start: new Date(start).toISOString(), end: new Date(start + Number(data.get('duration')) * minute).toISOString(),
    host: name || '訪客', avatarColor: 'moss', initials: name.slice(0, 1) || '訪',
    note: String(data.get('note')).trim(),
  };
  save({ sessions: [session, ...state.sessions] });
  dialog.close();
  navigate('plans');
  toast('已發起讀書邀約。');
}

function updateReservation(id, status) {
  const entry = state.reservations[id];
  if (!entry) return;
  const change = {
    confirmed: ['pending', '已模擬對方確認。'],
    completed: ['confirmed', '已記錄共讀完成。'],
    cancelled: [entry.status, '已取消預約。'],
  }[status];
  if (entry.status !== change[0]) return;
  save({ reservations: { ...state.reservations, [id]: { ...entry, status, updatedAt: Date.now() } } });
  render();
  toast(change[1]);
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
    if (dialog.open) dialog.close();
    navigate(nav.dataset.view);
    app.querySelector('main').focus({ preventScroll: true });
    return;
  }

  const control = event.target.closest('[data-action]');
  if (!control) return;
  const { action, id, value } = control.dataset;
  switch (action) {
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
    case 'confirm': updateReservation(id, 'confirmed'); break;
    case 'complete': updateReservation(id, 'completed'); break;
    case 'cancel': updateReservation(id, 'cancelled'); break;
    case 'close-invite':
      save({ sessions: state.sessions.map(session => session.id === id ? { ...session, closed: true } : session) });
      render();
      toast('已關閉讀書邀約。');
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
    const region = target.form.elements.namedItem('region');
    region.disabled = target.value === 'online';
    region.closest('.field').hidden = region.disabled;
  }
  if (target.name === 'schedule') {
    const start = target.form.elements.namedItem('start');
    start.required = target.value === 'later';
    start.disabled = !start.required;
    start.closest('.field').hidden = start.disabled;
  }
});

dialog.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const session = getSession(form.dataset.id);
  switch (form.dataset.form) {
    case 'profile': {
      const profile = Object.fromEntries(data);
      profile.name = profile.name.trim();
      save({ profile });
      dialog.close();
      render();
      app.querySelector('.profile-trigger').focus();
      toast('已儲存你的偏好。');
      break;
    }
    case 'filters':
      filters = { ...filters, ...Object.fromEntries(data), cross: data.has('cross') };
      dialog.close();
      refreshResults();
      break;
    case 'publish':
      handlePublish(form, data);
      break;
    case 'join':
      if (!session || hasEnded(session) || session.closed || session.own || session.joined >= session.capacity || !data.has('agree')) return;
      if (state.reservations[session.id] && state.reservations[session.id].status !== 'cancelled') return;
      save({ reservations: { ...state.reservations, [session.id]: { session, status: 'pending', updatedAt: Date.now() } } });
      dialog.close();
      navigate('plans');
      toast('已送出示範申請，等待對方確認。');
      break;
    case 'report':
      if (!session) return;
      save({ reports: [...state.reports, { id: session.id, reason: data.get('reason'), at: new Date().toISOString() }] });
      dialog.close();
      toast('已在此瀏覽器儲存示範檢舉。');
      break;
    case 'block':
      if (!session) return;
      save({ blocked: [...new Set([...state.blocked, session.host])] });
      dialog.close();
      refreshResults();
      toast('已隱藏該夥伴的邀約。');
      break;
  }
});

window.addEventListener('hashchange', () => {
  const next = activeView();
  if (next === view) return;
  view = next;
  if (dialog.open) dialog.close();
  render();
  window.scrollTo(0, 0);
});

render();
