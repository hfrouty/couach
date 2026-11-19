const PRESETS = [
  { minutes: 25, label: '25 分鐘專注' },
  { minutes: 50, label: '50 分鐘專注' },
  { minutes: 5, label: '5 分鐘休息' }
];

const MINUTE = 60_000;
const taipeiDate = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function newTimer(minutes = 25) {
  return { minutes, remaining: minutes * MINUTE, endsAt: null };
}

function timerText(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1_000);
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function createStudyTools({ read, save, icons, toast, places, escape }) {
  function currentTimer() {
    const timer = read().focus;
    return PRESETS.some(({ minutes }) => minutes === timer?.minutes) ? timer : newTimer();
  }

  function remainingTime(timer, now = Date.now()) {
    return timer.endsAt === null ? timer.remaining : Math.max(0, timer.endsAt - now);
  }

  function renderHistory() {
    const log = read().focusLog ?? [];
    const totalMinutes = log.reduce((total, session) => total + session.minutes, 0);
    return `
      <div class="focus-totals">
        <div><strong>${totalMinutes}</strong><span>專注分鐘</span></div>
        <div><strong>${log.length}</strong><span>完成場次</span></div>
      </div>
      ${log.length ? `
        <ul class="focus-history-list">
          ${log.slice(-5).reverse().map(({ at, minutes }) => `
            <li>
              <span class="focus-history-icon" aria-hidden="true">${icons('check')}</span>
              <span>完成 ${minutes} 分鐘專注</span>
              <time datetime="${escape(at)}">${taipeiDate.format(new Date(at))}</time>
            </li>
          `).join('')}
        </ul>` : '<p class="empty-state">完成一次專注後，紀錄就會出現在這裡。</p>'}
    `;
  }

  function renderFocus() {
    const timer = currentTimer();
    const running = timer.endsAt !== null;
    return `
      <header class="tool-heading">
        <h1>專注計時</h1>
        <p>安排一段專心讀書的時間，累積自己的學習紀錄。</p>
      </header>
      <div class="tool-grid focus-grid">
        <section class="tool-panel focus-timer" aria-labelledby="timer-title">
          <h2 id="timer-title">${icons('clock')} 番茄鐘</h2>
          <div class="timer-presets" role="group" aria-label="計時長度">
            ${PRESETS.map(({ minutes, label }) => `
              <button type="button" data-focus-action="preset" data-minutes="${minutes}"
                aria-pressed="${timer.minutes === minutes}">${label}</button>`).join('')}
          </div>
          <div class="timer-display" data-timer-display role="timer"
            aria-label="剩餘時間">${timerText(remainingTime(timer))}</div>
          <div class="timer-actions">
            <button class="button button-primary" type="button" data-focus-action="toggle">
              ${running ? `${icons('pause')} 暫停` : `${icons('play')} 開始`}
            </button>
            <button class="button button-secondary" type="button" data-focus-action="reset">
              ${icons('rotate')} 重設
            </button>
          </div>
        </section>
        <section class="tool-panel focus-history" aria-labelledby="focus-history-title">
          <h2 id="focus-history-title">學習紀錄</h2>
          <div data-focus-history>${renderHistory()}</div>
        </section>
      </div>
    `;
  }

  function renderPlaces() {
    return `
      <header class="tool-heading">
        <h1>讀書空間</h1>
        <p>探索暨大校園周邊適合共讀的公共空間。</p>
      </header>
      <div class="tool-grid place-grid">
        ${places.map(({ name, region, type, note, mapQuery }) => `
          <article class="tool-panel place-card">
            <div class="place-visual" aria-hidden="true">
              ${icons(type.includes('咖啡') ? 'cup' : 'library')}
            </div>
            <div class="place-copy">
              <p class="eyebrow">${escape(type)}</p>
              <h2>${escape(name)}</h2>
              <p class="place-region">${icons('pin')} ${escape(region)}</p>
              <p>${escape(note)}</p>
              <a class="button button-secondary"
                href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(mapQuery)}"
                target="_blank" rel="noopener noreferrer" aria-label="在地圖搜尋${escape(name)}">
                ${icons('map')} 查看地圖
              </a>
            </div>
          </article>
        `).join('')}
      </div>
      <p class="places-note">空間為示範參考，開放時間與使用規定請以場館公告為準。</p>
    `;
  }

  function bind(root, view) {
    if (view !== 'focus') return () => {};

    const display = root.querySelector('[data-timer-display]');
    const toggle = root.querySelector('[data-focus-action="toggle"]');
    const presets = root.querySelectorAll('[data-focus-action="preset"]');
    const history = root.querySelector('[data-focus-history]');

    function update() {
      const timer = currentTimer();
      const remaining = remainingTime(timer);
      const isRunning = timer.endsAt !== null;
      const time = timerText(remaining);
      if (display.textContent !== time) display.textContent = time;
      if (toggle.dataset.running !== String(isRunning)) {
        toggle.dataset.running = String(isRunning);
        toggle.innerHTML = isRunning ? `${icons('pause')} 暫停` : `${icons('play')} 開始`;
      }
      for (const preset of presets) {
        const selected = String(Number(preset.dataset.minutes) === timer.minutes);
        if (preset.getAttribute('aria-pressed') !== selected) {
          preset.setAttribute('aria-pressed', selected);
        }
      }
    }

    function finishIfDue(now = Date.now()) {
      const timer = currentTimer();
      if (timer.endsAt === null || timer.endsAt > now) return;

      const next = { focus: newTimer(timer.minutes) };
      const isBreak = timer.minutes === 5;
      if (!isBreak) {
        next.focusLog = [
          ...(read().focusLog ?? []),
          { minutes: timer.minutes, at: new Date(timer.endsAt).toISOString() }
        ];
      }
      save(next);
      if (!isBreak) history.innerHTML = renderHistory();
      toast(isBreak ? '休息時間結束。' : `已記錄 ${timer.minutes} 分鐘專注。`);
    }

    function tick() {
      finishIfDue();
      update();
    }

    function onClick(event) {
      const button = event.target.closest('[data-focus-action]');
      if (!button) return;

      const now = Date.now();
      finishIfDue(now);
      const timer = currentTimer();
      switch (button.dataset.focusAction) {
        case 'preset':
          if (Number(button.dataset.minutes) !== timer.minutes) {
            save({ focus: newTimer(Number(button.dataset.minutes)) });
          }
          break;
        case 'toggle':
          if (timer.endsAt === null) {
            save({ focus: { ...timer, endsAt: now + timer.remaining } });
          } else {
            save({ focus: { ...timer, remaining: remainingTime(timer, now), endsAt: null } });
          }
          break;
        case 'reset':
          save({ focus: newTimer(timer.minutes) });
          break;
      }
      update();
    }

    root.addEventListener('click', onClick);
    tick();
    const interval = setInterval(tick, 250);
    return () => {
      root.removeEventListener('click', onClick);
      clearInterval(interval);
    };
  }

  function render(view) {
    if (view === 'focus') return renderFocus();
    if (view === 'places') return renderPlaces();
    return '';
  }

  return { render, bind };
}
