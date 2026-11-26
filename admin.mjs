import { icon } from './icons.mjs';

const page = document.querySelector('#admin');
const dates = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const updateDates = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const accountTableSize = new ResizeObserver(updateAccountTableHint);

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || '目前無法完成操作。');
  return data;
}

function showError(message, scope = page) {
  const alert = scope.querySelector('[role="alert"]');
  if (alert) {
    alert.hidden = false;
    alert.textContent = message;
  } else {
    accountTableSize.disconnect();
    page.innerHTML = `<div class="admin-notice"><h1>管理後台</h1><p role="alert">${escape(message)}</p><button class="button button-secondary" data-refresh>重試</button></div>`;
  }
}

function renderSignIn(setup, account, notice = '') {
  accountTableSize.disconnect();
  const heading = setup ? '建立管理員帳號' : '管理員登入';
  page.innerHTML = `
    <section class="admin-auth-panel tool-panel">
      <span class="tile-icon">${icon('shield')}</span>
      <h1${notice ? ' tabindex="-1" aria-describedby="admin-auth-notice"' : ''}>${heading}</h1>
      <p>${setup ? '使用部署時設定的一次性啟用碼，建立唯一的管理員帳號。' : '使用管理員的電子郵件和密碼登入後台。'}</p>
      ${account ? '<p class="admin-callout">目前使用學生帳號登入。登入管理員帳號後即可查看後台。</p>' : ''}
      ${notice ? `<p id="admin-auth-notice" class="admin-success" role="status">${escape(notice)}</p>` : ''}
      <form class="dialog-form" data-auth="${setup ? 'setup' : 'login'}">
        ${setup ? '<label class="field"><span>啟用碼</span><input name="setupToken" type="password" required maxlength="256" autocomplete="off"></label><label class="field"><span>暱稱</span><input name="name" required maxlength="40" autocomplete="nickname"></label>' : ''}
        <label class="field"><span>電子郵件</span><input name="email" type="email" required maxlength="254" autocomplete="username"></label>
        <label class="field"><span>密碼</span><input name="password" type="password" required ${setup ? 'minlength="12" autocomplete="new-password"' : 'autocomplete="current-password"'} maxlength="256"></label>
        ${setup ? '<small class="form-note">密碼至少 12 個字元。</small>' : ''}
        <p class="admin-error" role="alert" hidden></p>
        <button type="submit" class="button button-primary">${setup ? '建立管理員' : '登入後台'}</button>
      </form>
    </section>`;
}

function renderDashboard(account, { accounts, reports, counts }) {
  accountTableSize.disconnect();
  page.innerHTML = `
    <header class="admin-heading">
      <div><h1>管理後台</h1><p>${escape(account.name)} · 管理員</p></div>
      <div class="admin-actions">
        <button type="button" class="button button-secondary" data-update-overview>${icon('rotate')} <span>更新資料</span></button>
        <button type="button" class="button button-secondary" data-open-password aria-haspopup="dialog" aria-controls="admin-password-dialog">變更密碼</button>
        <button type="button" class="button button-primary" data-logout>登出</button>
      </div>
    </header>
    <p class="admin-update-status" role="status" aria-atomic="true" data-update-status></p>
    <p class="admin-error" role="alert" hidden></p>
    <div data-overview></div>
    <dialog id="admin-password-dialog" aria-labelledby="admin-password-title" aria-describedby="admin-password-description">
      <header class="dialog-header">
        <div>
          <h2 id="admin-password-title">變更管理員密碼</h2>
          <p id="admin-password-description">更新密碼後，所有管理員登入階段都會登出。</p>
        </div>
      </header>
      <form class="dialog-form" method="post" data-password>
        <label class="field"><span>目前密碼</span><input name="currentPassword" type="password" required maxlength="256" autocomplete="current-password" autofocus></label>
        <label class="field">
          <span>新密碼</span>
          <input name="newPassword" type="password" required minlength="12" maxlength="256" autocomplete="new-password" aria-describedby="admin-password-length">
          <small id="admin-password-length" class="form-note">請使用 12 到 128 個字元。</small>
        </label>
        <label class="field"><span>確認新密碼</span><input name="confirmPassword" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label>
        <p class="admin-error" role="alert" hidden></p>
        <div class="admin-password-actions">
          <button type="button" class="button button-secondary" data-close-password>取消</button>
          <button type="submit" class="button button-primary">更新密碼</button>
        </div>
      </form>
    </dialog>`;
  renderOverview({ accounts, reports, counts });
  showUpdateStatus(new Date());
}

function renderOverview({ accounts, reports, counts }) {
  accountTableSize.disconnect();
  const viewport = page.querySelector('[data-overview]');
  const previousScrollLeft = viewport.querySelector('[data-account-table]')?.scrollLeft ?? 0;
  viewport.innerHTML = `
    <div class="admin-summary">
      ${[['讀書邀約', counts.sessions], ['預約申請', counts.reservations], ['待處理檢舉', counts.reports]].map(([label, number]) => `
        <div class="tool-panel admin-metric"><span>${label}</span><strong>${Number(number) || 0}</strong></div>
      `).join('')}
    </div>
    <section class="tool-panel admin-panel" aria-labelledby="reports-title">
      <h2 id="reports-title">${icon('flag')} 檢舉紀錄</h2>
      ${reports.length ? `<div class="admin-table-wrap"><table>
        <thead><tr><th scope="col">檢舉項目</th><th scope="col">檢舉人</th><th scope="col">原因</th><th scope="col">時間</th><th scope="col">處理狀態</th></tr></thead>
        <tbody>${reports.map(report => `
          <tr><td>${escape(report.title)}${report.reportedEmail ? `<br><small>被檢舉帳號 ${escape(report.reportedEmail)}</small>` : ''}</td><td>${escape(report.reporter)}</td><td>${escape(report.reason)}</td>
            <td><time datetime="${escape(report.createdAt)}">${dateOf(report.createdAt)}</time></td>
            <td>${report.status === 'open' ? `<button type="button" class="button button-secondary" data-resolve="${escape(report.id)}">標記已處理</button>
              ${report.canClose ? `<button type="button" class="button button-secondary" data-close-reported-invitation="${escape(report.id)}">關閉邀約並處理</button>` : ''}` : '<span class="status-pill status-live">已處理</span>'}</td></tr>
        `).join('')}</tbody>
      </table></div>` : '<p class="admin-empty">目前沒有檢舉。</p>'}
    </section>
    <section class="tool-panel admin-panel" aria-labelledby="accounts-title">
      <h2 id="accounts-title">${icon('users')} 帳號清單</h2>
      <p class="admin-scroll-hint" id="admin-account-scroll-hint" hidden>左右滑動可查看角色與註冊時間</p>
      <div class="admin-table-wrap" role="region" aria-labelledby="accounts-title" data-account-table><table>
        <thead><tr><th scope="col">暱稱</th><th scope="col">電子郵件</th><th scope="col">角色</th><th scope="col">註冊時間</th></tr></thead>
        <tbody>${accounts.map(member => `
          <tr><td>${escape(member.name)}</td><td>${escape(member.email)}</td>
            <td>${member.role === 'admin' ? '管理員' : '學生'}</td><td>${dateOf(member.createdAt)}</td></tr>
        `).join('')}</tbody>
      </table></div>
    </section>`;
  const accountTable = viewport.querySelector('[data-account-table]');
  accountTable.scrollLeft = previousScrollLeft;
  updateAccountTableHint();
  accountTableSize.observe(accountTable);
  accountTableSize.observe(accountTable.querySelector('table'));
}

function updateAccountTableHint() {
  const viewport = page.querySelector('[data-account-table]');
  if (!viewport) return;
  const hint = page.querySelector('#admin-account-scroll-hint');
  const overflow = viewport.scrollWidth > viewport.clientWidth;
  hint.hidden = !overflow;
  viewport.tabIndex = overflow ? 0 : -1;
  if (overflow) viewport.setAttribute('aria-describedby', hint.id);
  else viewport.removeAttribute('aria-describedby');
}

function showUpdateStatus(lastUpdated, message = '', failed = false) {
  const status = page.querySelector('[data-update-status]');
  status.classList.toggle('admin-update-failure', failed);
  status.innerHTML = `
    ${message ? `<strong>${escape(message)}</strong>` : ''}
    <span>最後成功更新（台灣時間） <time datetime="${lastUpdated.toISOString()}">${updateDates.format(lastUpdated)}</time></span>`;
}

async function updateOverview(control) {
  if (control.getAttribute('aria-disabled') === 'true') return;
  const label = control.querySelector('span');
  const lastUpdated = new Date(page.querySelector('[data-update-status] time').dateTime);
  control.setAttribute('aria-disabled', 'true');
  label.textContent = '更新中…';
  showUpdateStatus(lastUpdated, '更新中…');
  try {
    const overview = await api('/api/admin/overview');
    if (!control.isConnected) return;
    renderOverview(overview);
    showUpdateStatus(new Date(), '已更新');
  } catch {
    if (control.isConnected) showUpdateStatus(lastUpdated, '更新失敗，請再按「更新資料」重試。', true);
  } finally {
    label.textContent = '更新資料';
    control.removeAttribute('aria-disabled');
  }
}

function dateOf(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dates.format(date) : '—';
}

async function refresh() {
  const { account, adminSetup } = await api('/api/account');
  if (account?.role === 'admin') {
    renderDashboard(account, await api('/api/admin/overview'));
    return;
  }
  renderSignIn(adminSetup, account);
}

async function perform(target, action) {
  if (target.disabled) return;
  target.disabled = true;
  const alert = page.querySelector('[role="alert"]');
  if (alert) alert.hidden = true;
  try {
    await action();
    await refresh();
  } catch (error) {
    showError(error.message || '無法連線到 StudyMate。');
  } finally {
    target.disabled = false;
  }
}

async function changePassword(form) {
  if (form.hasAttribute('aria-busy')) return;
  const { currentPassword, newPassword, confirmPassword } = Object.fromEntries(new FormData(form));
  const length = [...newPassword].length;
  if (length < 12 || length > 128) {
    showError('新密碼須為 12 到 128 個字元。', form);
    form.elements.newPassword.focus();
    return;
  }
  if (newPassword !== confirmPassword) {
    showError('兩次輸入的新密碼不一致。', form);
    form.elements.confirmPassword.focus();
    return;
  }
  form.querySelector('[role="alert"]').hidden = true;
  form.setAttribute('aria-busy', 'true');
  for (const control of form.elements) control.disabled = true;
  try {
    await api('/api/admin/password', { currentPassword, newPassword });
    form.reset();
    form.closest('dialog').close();
    renderSignIn(false, null, '密碼已變更。請用新密碼重新登入。');
    page.querySelector('h1').focus();
  } catch (error) {
    showError(error.message || '無法連線到 StudyMate。', form);
  } finally {
    form.removeAttribute('aria-busy');
    for (const control of form.elements) control.disabled = false;
  }
}

page.addEventListener('submit', event => {
  const form = event.target.closest('[data-auth], [data-password]');
  if (!form) return;
  event.preventDefault();
  if ('password' in form.dataset) {
    void changePassword(form);
    return;
  }
  const body = Object.fromEntries(new FormData(form));
  perform(event.submitter || form.querySelector('[type="submit"]'), () => api(`/api/auth/${form.dataset.auth}`, body));
});

page.addEventListener('click', event => {
  const control = event.target.closest('button');
  if (!control) return;
  if ('refresh' in control.dataset) perform(control, async () => {});
  if ('updateOverview' in control.dataset) void updateOverview(control);
  if ('logout' in control.dataset) perform(control, () => api('/api/auth/logout', {}));
  if ('openPassword' in control.dataset) page.querySelector('#admin-password-dialog').showModal();
  if ('closePassword' in control.dataset) control.closest('dialog').close();
  if (control.dataset.resolve) {
    perform(control, () => api(`/api/admin/reports/${encodeURIComponent(control.dataset.resolve)}/resolve`, {}));
  }
  if (control.dataset.closeReportedInvitation && window.confirm('關閉後將取消這場邀約待處理及已確認的預約，並將這筆檢舉標記為已處理。確定要關閉嗎？')) {
    perform(control, () => api(`/api/admin/reports/${encodeURIComponent(control.dataset.closeReportedInvitation)}/close-invitation`, {}));
  }
});

page.addEventListener('cancel', event => {
  if (event.target.matches('#admin-password-dialog') && event.target.querySelector('form[aria-busy]')) {
    event.preventDefault();
  }
}, true);

page.addEventListener('close', event => {
  if (!event.target.matches('#admin-password-dialog')) return;
  event.target.querySelector('form').reset();
  event.target.querySelector('[role="alert"]').hidden = true;
}, true);

refresh().catch(error => showError(error.message || '無法連線到 StudyMate。'));
