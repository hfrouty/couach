import { icon } from './icons.mjs';

const page = document.querySelector('#admin');
const dates = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

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
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '目前無法完成操作。');
  return data;
}

function showError(message) {
  const alert = page.querySelector('[role="alert"]');
  if (alert) {
    alert.hidden = false;
    alert.textContent = message;
  } else {
    page.innerHTML = `<div class="admin-notice"><h1>管理後台</h1><p role="alert">${escape(message)}</p><button class="button button-secondary" data-refresh>重試</button></div>`;
  }
}

function renderSignIn(setup, account) {
  const heading = setup ? '建立管理員帳號' : '管理員登入';
  page.innerHTML = `
    <section class="admin-auth-panel tool-panel">
      <span class="tile-icon">${icon('shield')}</span>
      <h1>${heading}</h1>
      <p>${setup ? '使用部署時設定的一次性啟用碼，建立唯一的管理員帳號。' : '使用管理員的電子郵件和密碼登入後台。'}</p>
      ${account ? '<p class="admin-callout">目前使用學生帳號登入。登入管理員帳號後即可查看後台。</p>' : ''}
      <form class="dialog-form" data-auth="${setup ? 'setup' : 'login'}">
        ${setup ? '<label class="field"><span>啟用碼</span><input name="setupToken" type="password" required maxlength="256" autocomplete="off"></label><label class="field"><span>暱稱</span><input name="name" required maxlength="40" autocomplete="nickname"></label>' : ''}
        <label class="field"><span>電子郵件</span><input name="email" type="email" required maxlength="254" autocomplete="username"></label>
        <label class="field"><span>密碼</span><input name="password" type="password" required ${setup ? 'minlength="12" autocomplete="new-password"' : 'autocomplete="current-password"'} maxlength="128"></label>
        ${setup ? '<small class="form-note">密碼至少 12 個字元。</small>' : ''}
        <p class="admin-error" role="alert" hidden></p>
        <button type="submit" class="button button-primary">${setup ? '建立管理員' : '登入後台'}</button>
      </form>
    </section>`;
}

function renderDashboard(account, { accounts, reports, counts }) {
  page.innerHTML = `
    <header class="admin-heading">
      <div><h1>管理後台</h1><p>${escape(account.name)} · 管理員</p></div>
      <div class="admin-actions">
        <button type="button" class="button button-secondary" data-refresh>${icon('rotate')} 更新資料</button>
        <button type="button" class="button button-primary" data-logout>登出</button>
      </div>
    </header>
    <p class="admin-error" role="alert" hidden></p>
    <div class="admin-summary">
      ${[['讀書邀約', counts.sessions], ['預約申請', counts.reservations], ['待處理檢舉', counts.reports]].map(([label, number]) => `
        <div class="tool-panel admin-metric"><span>${label}</span><strong>${Number(number) || 0}</strong></div>
      `).join('')}
    </div>
    <section class="tool-panel admin-panel" aria-labelledby="reports-title">
      <h2 id="reports-title">${icon('flag')} 檢舉紀錄</h2>
      ${reports.length ? `<div class="admin-table-wrap"><table>
        <thead><tr><th scope="col">邀約</th><th scope="col">檢舉人</th><th scope="col">原因</th><th scope="col">時間</th><th scope="col">處理狀態</th></tr></thead>
        <tbody>${reports.map(report => `
          <tr><td>${escape(report.title)}</td><td>${escape(report.reporter)}</td><td>${escape(report.reason)}</td>
            <td><time datetime="${escape(report.createdAt)}">${dateOf(report.createdAt)}</time></td>
            <td>${report.status === 'open' ? `<button type="button" class="button button-secondary" data-resolve="${escape(report.id)}">標記已處理</button>` : '<span class="status-pill status-live">已處理</span>'}</td></tr>
        `).join('')}</tbody>
      </table></div>` : '<p class="admin-empty">目前沒有檢舉。</p>'}
    </section>
    <section class="tool-panel admin-panel" aria-labelledby="accounts-title">
      <h2 id="accounts-title">${icon('users')} 帳號清單</h2>
      <div class="admin-table-wrap"><table>
        <thead><tr><th scope="col">暱稱</th><th scope="col">電子郵件</th><th scope="col">角色</th><th scope="col">註冊時間</th></tr></thead>
        <tbody>${accounts.map(member => `
          <tr><td>${escape(member.name)}</td><td>${escape(member.email)}</td>
            <td>${member.role === 'admin' ? '管理員' : '學生'}</td><td>${dateOf(member.createdAt)}</td></tr>
        `).join('')}</tbody>
      </table></div>
    </section>`;
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

page.addEventListener('submit', event => {
  const form = event.target.closest('[data-auth]');
  if (!form) return;
  event.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  perform(event.submitter || form.querySelector('[type="submit"]'), () => api(`/api/auth/${form.dataset.auth}`, body));
});

page.addEventListener('click', event => {
  const control = event.target.closest('button');
  if (!control) return;
  if ('refresh' in control.dataset) perform(control, async () => {});
  if ('logout' in control.dataset) perform(control, () => api('/api/auth/logout', {}));
  if (control.dataset.resolve) {
    perform(control, () => api(`/api/admin/reports/${encodeURIComponent(control.dataset.resolve)}/resolve`, {}));
  }
});

refresh().catch(error => showError(error.message || '無法連線到 StudyMate。'));
