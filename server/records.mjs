import { randomUUID } from 'node:crypto';
import { STYLES, SUBJECTS } from '../sample-data.mjs';
import { DEFAULT_CAMPUS_ID, getCampus } from '../campuses.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const COLORS = ['moss', 'plum', 'sand', 'sky'];
export const REPORT_REASONS = ['不當內容', '可疑邀約', '騷擾或安全疑慮', '其他'];
const SLOT_LENGTHS = [25, 50, 60, 90, 120];

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function text(value, limit, message, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim())) fail(400, message);
  return value.trim();
}

function invitationDetails(data, previousNote) {
  return {
    title: text(data?.title, 42, '邀約標題須介於 1 到 42 個字。'),
    note: text(data?.note === undefined ? previousNote : data.note, 180, '共讀說明最多 180 個字。', true),
  };
}

function invitationRegion(campus, mode, region) {
  if (mode === 'online') return '';
  if (!campus.regions.some(area => area.name === region)) fail(400, '請選擇此校園的有效區域。');
  return region;
}

function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const normalized = value.includes('.') ? value : `${value.slice(0, -1)}.000Z`;
  return new Date(time).toISOString() === normalized ? time : NaN;
}

function sessionData(row, viewerId) {
  const hostIndex = row.host_id.charCodeAt(0) % COLORS.length;
  const campus = getCampus(row.campus_id) ?? getCampus(DEFAULT_CAMPUS_ID);
  return {
    id: row.id,
    title: row.title,
    campusId: campus.id,
    school: campus.name,
    department: row.department,
    region: row.region,
    subject: row.subject,
    style: row.style,
    mode: row.mode,
    format: row.capacity === 2 ? 'pair' : 'group',
    capacity: row.capacity,
    joined: 1 + row.participant_count,
    start: new Date(row.starts_at).toISOString(),
    end: new Date(row.ends_at).toISOString(),
    host: row.host,
    hostId: row.host_id,
    avatarColor: COLORS[hostIndex],
    initials: Array.from(row.host)[0] ?? '讀',
    note: row.note,
    own: row.host_id === viewerId,
    closed: row.closed_at !== null,
    ...(row.is_quick_match ? {
      quickMatch: true,
      partner: { name: row.partner_name, department: row.partner_department },
    } : {}),
  };
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createStudyBlock(db) {
  const insertBlock = db.prepare(`
    INSERT INTO study_blocks (blocker_id, blocked_id) VALUES (?, ?)
    ON CONFLICT DO NOTHING
  `);
  const cancelBlockedRequests = db.prepare(`
    UPDATE reservations SET status = 'cancelled', updated_at = :now
    WHERE status IN ('pending', 'confirmed') AND EXISTS (
      SELECT 1 FROM study_sessions s
      WHERE s.id = reservations.session_id AND s.ends_at > :now
        AND ((reservations.applicant_id = :first AND s.host_id = :second)
          OR (reservations.applicant_id = :second AND s.host_id = :first))
    )
  `);
  return (first, second, now) => {
    insertBlock.run(first, second);
    cancelBlockedRequests.run({ now, first, second });
  };
}

export function createRecords(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS study_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      host_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      style TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('in-person', 'online')),
      campus_id TEXT NOT NULL DEFAULT 'ncnu',
      region TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity BETWEEN 2 AND 6),
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
      note TEXT NOT NULL,
      closed_at INTEGER,
      is_quick_match INTEGER NOT NULL DEFAULT 0 CHECK (is_quick_match IN (0, 1))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS study_sessions_host ON study_sessions(host_id);
    CREATE INDEX IF NOT EXISTS study_sessions_open ON study_sessions(ends_at) WHERE closed_at IS NULL;

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
      applicant_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
      updated_at INTEGER NOT NULL,
      UNIQUE (session_id, applicant_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS reservations_applicant ON reservations(applicant_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS reservations_capacity ON reservations(session_id, status);

    CREATE TABLE IF NOT EXISTS study_blocks (
      blocker_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      PRIMARY KEY (blocker_id, blocked_id),
      CHECK (blocker_id <> blocked_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS study_reports (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
      reporter_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      created_at INTEGER NOT NULL,
      UNIQUE (session_id, reporter_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS study_reports_queue ON study_reports(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS study_match_reports (
      id TEXT PRIMARY KEY NOT NULL,
      ticket_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      reported_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      created_at INTEGER NOT NULL,
      UNIQUE (ticket_id, reporter_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS study_match_reports_queue ON study_match_reports(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS focus_entries (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      minutes INTEGER NOT NULL CHECK (minutes IN (25, 50)),
      PRIMARY KEY (account_id, at)
    ) STRICT;
  `);

  // Invites created before campus selection were all assigned to NCNU.
  transaction(db, () => {
    const columns = db.prepare('PRAGMA table_info(study_sessions)').all();
    if (!columns.some(column => column.name === 'campus_id')) {
      db.exec("ALTER TABLE study_sessions ADD COLUMN campus_id TEXT NOT NULL DEFAULT 'ncnu'");
    }
    if (!columns.some(column => column.name === 'is_quick_match')) {
      db.exec('ALTER TABLE study_sessions ADD COLUMN is_quick_match INTEGER NOT NULL DEFAULT 0 CHECK (is_quick_match IN (0, 1))');
    }
  });

  const sessionColumns = `
    s.*, host.name AS host, host.department,
    (SELECT COUNT(*) FROM reservations
     WHERE session_id = s.id AND status IN ('confirmed', 'completed')) AS participant_count
  `;
  const notBlocked = `
    NOT EXISTS (
      SELECT 1 FROM study_blocks b
      WHERE (b.blocker_id = :account AND b.blocked_id = s.host_id)
         OR (b.blocker_id = s.host_id AND b.blocked_id = :account)
    )`;
  const openSessions = db.prepare(`
    SELECT ${sessionColumns}
    FROM study_sessions s JOIN accounts host ON host.id = s.host_id
    WHERE s.is_quick_match = 0
      AND (s.host_id = :account OR (s.closed_at IS NULL AND s.ends_at > :now AND ${notBlocked}))
    ORDER BY s.starts_at, s.id
  `);
  const ownReservations = db.prepare(`
    SELECT ${sessionColumns}, r.id AS reservation_id, r.status, r.updated_at,
           CASE WHEN s.host_id = :account THEN guest.name ELSE host.name END AS partner_name,
           CASE WHEN s.host_id = :account THEN guest.department ELSE host.department END AS partner_department
    FROM reservations r JOIN study_sessions s ON s.id = r.session_id
    JOIN accounts host ON host.id = s.host_id
    JOIN accounts guest ON guest.id = r.applicant_id
    WHERE r.applicant_id = :account OR (s.is_quick_match = 1 AND s.host_id = :account)
    ORDER BY r.updated_at DESC, r.id
  `);
  const receivedReservations = db.prepare(`
    SELECT r.id, r.session_id AS sessionId, s.title, student.name,
           r.status, r.updated_at AS updatedAt
    FROM study_sessions s JOIN reservations r ON r.session_id = s.id
    JOIN accounts student ON student.id = r.applicant_id
    WHERE s.host_id = ? AND s.is_quick_match = 0
    ORDER BY r.updated_at DESC, r.id
  `);
  const focusEntries = db.prepare('SELECT minutes, at FROM focus_entries WHERE account_id = ? ORDER BY at');
  const insertSession = db.prepare(`
    INSERT INTO study_sessions (id, host_id, title, subject, style, mode, campus_id, region, capacity, starts_at, ends_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getSession = db.prepare(`
    SELECT s.*, (SELECT applicant_id FROM reservations WHERE session_id = s.id AND s.is_quick_match = 1) AS match_partner_id
    FROM study_sessions s WHERE s.id = ?
  `);
  const editSession = db.prepare('UPDATE study_sessions SET title = ?, region = ?, note = ? WHERE id = ?');
  const findBlock = db.prepare(`
    SELECT 1 FROM study_blocks
    WHERE (blocker_id = :first AND blocked_id = :second)
       OR (blocker_id = :second AND blocked_id = :first)
    LIMIT 1
  `);
  const closeSession = db.prepare('UPDATE study_sessions SET closed_at = ? WHERE id = ?');
  const cancelSessionRequests = db.prepare(`
    UPDATE reservations SET status = 'cancelled', updated_at = ?
    WHERE session_id = ? AND status IN ('pending', 'confirmed')
  `);
  const lookupApplication = db.prepare('SELECT id, status FROM reservations WHERE session_id = ? AND applicant_id = ?');
  const lookupReservation = db.prepare(`
    SELECT r.*, s.host_id, s.capacity, s.starts_at, s.ends_at, s.closed_at, s.is_quick_match
    FROM reservations r JOIN study_sessions s ON s.id = r.session_id
    WHERE r.id = ?
  `);
  const participants = db.prepare(`
    SELECT COUNT(*) AS count FROM reservations WHERE session_id = ? AND status IN ('confirmed', 'completed')
  `);
  const insertReservation = db.prepare(`
    INSERT INTO reservations (id, session_id, applicant_id, status, updated_at)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  const updateReservation = db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?');
  const insertReport = db.prepare(`
    INSERT INTO study_reports (id, session_id, reporter_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (session_id, reporter_id) DO NOTHING
  `);
  const blockAccounts = createStudyBlock(db);
  const insertFocus = db.prepare(`
    INSERT INTO focus_entries (account_id, at, minutes) VALUES (?, ?, ?)
    ON CONFLICT (account_id, at) DO NOTHING
  `);
  const reviewReports = db.prepare(`
    SELECT * FROM (
      SELECT r.id, s.title, a.name AS reporter, r.reason, r.status, r.created_at, NULL AS reportedEmail,
             (s.is_quick_match = 0 AND s.closed_at IS NULL AND s.ends_at > ?) AS canClose
      FROM study_reports r JOIN study_sessions s ON s.id = r.session_id
      JOIN accounts a ON a.id = r.reporter_id
      UNION ALL
      SELECT r.id, '匿名配對' AS title, a.name AS reporter, r.reason, r.status, r.created_at, target.email AS reportedEmail,
             0 AS canClose
      FROM study_match_reports r JOIN accounts a ON a.id = r.reporter_id
      JOIN accounts target ON target.id = r.reported_id
    )
    ORDER BY (status = 'open') DESC, created_at DESC
    LIMIT 200
  `);
  const reviewCounts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM study_sessions WHERE is_quick_match = 0) AS sessions,
      (SELECT COUNT(*) FROM reservations r JOIN study_sessions s ON s.id = r.session_id WHERE s.is_quick_match = 0) AS reservations,
      (SELECT COUNT(*) FROM study_reports WHERE status = 'open')
        + (SELECT COUNT(*) FROM study_match_reports WHERE status = 'open') AS reports
  `);
  const reviewUpdate = db.prepare("UPDATE study_reports SET status = 'resolved' WHERE id = ?");
  const reviewMatchUpdate = db.prepare("UPDATE study_match_reports SET status = 'resolved' WHERE id = ?");
  const reportedInvitation = db.prepare(`
    SELECT s.* FROM study_reports r JOIN study_sessions s ON s.id = r.session_id
    WHERE r.id = ? AND s.is_quick_match = 0
  `);
  const removeJoinedQuickMatches = db.prepare(`
    DELETE FROM study_sessions WHERE is_quick_match = 1 AND id IN (
      SELECT session_id FROM reservations WHERE applicant_id = ?
    )
  `);

  function sessionById(id, account, allowQuickMatch = false) {
    const session = typeof id === 'string' ? getSession.get(id) : null;
    if (!session || (session.is_quick_match && (!allowQuickMatch
      || (session.host_id !== account.id && session.match_partner_id !== account.id)))) {
      fail(404, '找不到這場邀約。');
    }
    return session;
  }

  function blocked(first, second) {
    return Boolean(findBlock.get({ first, second }));
  }

  function checkCapacity(sessionId, capacity) {
    if (1 + participants.get(sessionId).count >= capacity) fail(409, '這場邀約已額滿。');
  }

  function partnerOf(session, accountId) {
    return session.is_quick_match && session.host_id === accountId ? session.match_partner_id : session.host_id;
  }

  function canTarget(account, session, target = partnerOf(session, account.id)) {
    if (target === account.id) fail(400, '這場邀約由你發起。');
    if (blocked(account.id, target)) fail(404, '找不到這場邀約。');
    if (!session.is_quick_match && (session.closed_at !== null || session.ends_at <= Date.now()) && !lookupApplication.get(session.id, account.id)) {
      fail(404, '找不到這場邀約。');
    }
  }

  function state(account) {
    const sessions = openSessions.all({ account: account.id, now: Date.now() })
      .map(row => sessionData(row, account.id));
    const reservations = Object.fromEntries(ownReservations.all({ account: account.id }).map(row => [
      row.id, {
        id: row.reservation_id,
        session: sessionData(row, account.id),
        status: row.status,
        updatedAt: row.updated_at,
      },
    ]));
    const incoming = receivedReservations.all(account.id);
    const focusLog = focusEntries.all(account.id)
      .map(({ minutes, at }) => ({ minutes, at: new Date(at).toISOString() }));
    return { sessions, reservations, incoming, focusLog };
  }

  function publish(account, data) {
    const { title, note } = invitationDetails(data);
    const { subject, style, mode, capacity } = data;
    if (!SUBJECTS.includes(subject) || !STYLES.includes(style)) fail(400, '請選擇有效的科目和共讀習慣。');
    if (!['in-person', 'online'].includes(mode)) fail(400, '請選擇有效的共讀方式。');
    const campusId = data.campusId === undefined ? (account.campusId ?? DEFAULT_CAMPUS_ID) : data.campusId;
    const campus = typeof campusId === 'string' ? getCampus(campusId) : undefined;
    if (!campus) fail(400, '請選擇有效的邀約校園。');
    const region = invitationRegion(campus, mode, data.region);
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 6) fail(400, '共讀人數須介於 2 到 6 人。');
    const start = dateValue(data.start);
    const end = dateValue(data.end);
    const now = Date.now();
    if (!(start >= now - 5 * MINUTE && start <= now + 180 * DAY) || !SLOT_LENGTHS.includes((end - start) / MINUTE)) {
      fail(400, '請選擇 180 天內的開始時間與有效的共讀長度。');
    }

    const id = randomUUID();
    insertSession.run(id, account.id, title, subject, style, mode, campus.id, region, capacity, start, end, note);
    return { id };
  }

  function edit(account, id, data) {
    return transaction(db, () => {
      const session = sessionById(id, account);
      if (session.host_id !== account.id) fail(403, '只有發起人可以編輯邀約。');
      if (session.closed_at !== null || session.ends_at <= Date.now()) fail(409, '這場邀約已結束，無法編輯。');
      const { title, note } = invitationDetails(data, session.note);
      const campus = getCampus(session.campus_id) ?? getCampus(DEFAULT_CAMPUS_ID);
      const region = invitationRegion(campus, session.mode, data?.region);
      editSession.run(title, region, note, id);
      return { id };
    });
  }

  function closeInvitation(session) {
    if (session.closed_at !== null) return;
    const now = Date.now();
    closeSession.run(now, session.id);
    if (session.ends_at > now) cancelSessionRequests.run(now, session.id);
  }

  function close(account, id) {
    transaction(db, () => {
      const session = sessionById(id, account);
      if (session.host_id !== account.id) fail(403, '只有發起人可以關閉邀約。');
      closeInvitation(session);
    });
  }

  function requestJoin(account, id) {
    return transaction(db, () => {
      const session = sessionById(id, account);
      canTarget(account, session);
      const now = Date.now();
      if (session.closed_at !== null || session.ends_at <= now) fail(409, '這場邀約已結束。');
      const existing = lookupApplication.get(id, account.id);
      if (existing && existing.status !== 'cancelled') return { id: existing.id };
      checkCapacity(id, session.capacity);
      if (existing) {
        updateReservation.run('pending', now, existing.id);
        return { id: existing.id };
      }
      const reservationId = randomUUID();
      insertReservation.run(reservationId, id, account.id, now);
      return { id: reservationId };
    });
  }

  function setReservationStatus(account, id, status) {
    if (!['confirmed', 'completed', 'cancelled'].includes(status)) fail(400, '預約狀態無效。');
    transaction(db, () => {
      const entry = typeof id === 'string' ? lookupReservation.get(id) : null;
      const host = entry?.host_id === account.id;
      const applicant = entry?.applicant_id === account.id;
      if (!entry || (!host && !applicant)) fail(404, '找不到這筆預約。');
      const now = Date.now();
      switch (status) {
        case 'confirmed':
          if (!host) fail(403, '只有發起人可以確認加入申請。');
          if (entry.status === status) return;
          if (entry.status !== 'pending' || entry.closed_at !== null || entry.ends_at <= now || blocked(entry.applicant_id, entry.host_id)) {
            fail(409, '這筆申請已無法確認。');
          }
          checkCapacity(entry.session_id, entry.capacity);
          break;
        case 'completed':
          if (!applicant && !entry.is_quick_match) fail(403, '只有參與者可以標記自己的共讀已完成。');
          if (entry.status === status) return;
          if (entry.status !== 'confirmed' || now < entry.starts_at) fail(409, '共讀開始後才可標記完成。');
          break;
        case 'cancelled':
          if (entry.status === status) return;
          if (!['pending', 'confirmed'].includes(entry.status) || entry.ends_at <= now) fail(409, '這筆預約已無法取消。');
          break;
      }
      updateReservation.run(status, now, id);
    });
  }

  function report(account, id, reason) {
    if (!REPORT_REASONS.includes(reason)) fail(400, '請選擇有效的檢舉原因。');
    const session = sessionById(id, account, true);
    canTarget(account, session);
    insertReport.run(randomUUID(), session.id, account.id, reason, Date.now());
  }

  function block(account, id) {
    transaction(db, () => {
      const session = sessionById(id, account, true);
      const target = partnerOf(session, account.id);
      if (target === account.id) fail(400, '你無法封鎖自己。');
      const alreadyBlocked = blocked(account.id, target);
      if (alreadyBlocked) return;
      canTarget(account, session, target);
      blockAccounts(account.id, target, Date.now());
    });
  }

  function addFocus(account, data) {
    const at = dateValue(data?.at);
    const now = Date.now();
    if (![25, 50].includes(data?.minutes) || !(at >= now - 365 * DAY && at <= now + 5 * MINUTE)) {
      fail(400, '專注時間或完成日期無效。');
    }
    insertFocus.run(account.id, at, data.minutes);
  }

  function moderation() {
    const reports = reviewReports.all(Date.now()).map(({ created_at, canClose, ...row }) => ({
      ...row,
      canClose: Boolean(canClose),
      createdAt: new Date(created_at).toISOString(),
    }));
    return { reports, counts: reviewCounts.get() };
  }

  function resolveReport(id) {
    if (typeof id !== 'string' || (!reviewUpdate.run(id).changes && !reviewMatchUpdate.run(id).changes)) {
      fail(404, '找不到這筆檢舉。');
    }
  }

  function closeReportedInvitation(id) {
    transaction(db, () => {
      const session = reportedInvitation.get(id);
      if (!session) fail(404, '找不到被檢舉的邀約。');
      closeInvitation(session);
      reviewUpdate.run(id);
    });
  }

  function prepareAccountDeletion(accountId) {
    removeJoinedQuickMatches.run(accountId);
  }

  return {
    state, publish, edit, close, requestJoin, setReservationStatus, report, block,
    addFocus, moderation, resolveReport, closeReportedInvitation, prepareAccountDeletion,
  };
}
