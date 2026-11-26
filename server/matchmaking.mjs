import { randomUUID } from 'node:crypto';
import { getCampus } from '../campuses.mjs';
import { markerDistance } from '../matching.mjs';
import { getCafeById } from './taiwan-cafes.mjs';

const SEARCH_LEASE = 45_000;
const SEARCH_LIMIT = 120_000;
const ACCEPT_LIMIT = 60_000;
const EXPIRED_TICKET_RETENTION = 5 * 60_000;
const LOCATION_SHARE_LIFETIME = 10 * 60_000;
const ACTIONS = ['check', 'start', 'cancel', 'accept', 'decline', 'dismiss', 'select-cafe', 'share-location', 'update-location', 'stop-location'];

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function campusRegion(campus, name) {
  return campus?.regions.find(region => region.name === name);
}

function roundLocation(position) {
  if (!Array.isArray(position) || position.length !== 2) fail(400, '無法辨識你分享的位置。');
  const [latitude, longitude] = position;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    fail(400, '無法辨識你分享的位置。');
  }
  return position.map(coordinate => Math.round(coordinate * 10_000) / 10_000);
}

function selectRendezvous(campus, first, second) {
  const midpoint = first.position.map((coordinate, index) => (coordinate + second.position[index]) / 2);
  let nearest;
  let nearestDistance = Infinity;
  for (const venue of campus.regions) {
    if (!venue.placeType) continue;
    const distance = markerDistance(midpoint, venue.position);
    if (distance < nearestDistance) {
      nearest = venue;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function createMatchmaking(db) {
  // Personal locations live only in this process and never enter the study records.
  const locationShares = new Map();
  db.exec(`
    CREATE TABLE IF NOT EXISTS study_match_tickets (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      campus_id TEXT NOT NULL,
      region TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('searching', 'found', 'waiting', 'matched', 'dismissed')),
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      partner_ticket_id TEXT,
      rendezvous_region TEXT,
      cafe_id TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS study_match_one_ticket ON study_match_tickets(account_id) WHERE status <> 'dismissed';
    CREATE INDEX IF NOT EXISTS study_match_search ON study_match_tickets(campus_id, expires_at) WHERE status = 'searching';
    CREATE INDEX IF NOT EXISTS study_match_expiry ON study_match_tickets(expires_at);
    CREATE INDEX IF NOT EXISTS study_match_results ON study_match_tickets(partner_ticket_id) WHERE status = 'matched';
  `);
  transaction(() => {
    const columns = db.prepare('PRAGMA table_info(study_match_tickets)').all();
    if (!columns.some(({ name }) => name === 'rendezvous_region')) {
      db.exec('ALTER TABLE study_match_tickets ADD COLUMN rendezvous_region TEXT');
    }
    if (!columns.some(({ name }) => name === 'cafe_id')) {
      db.exec('ALTER TABLE study_match_tickets ADD COLUMN cafe_id TEXT');
    }
  });

  const currentTicket = db.prepare("SELECT * FROM study_match_tickets WHERE account_id = ? AND status <> 'dismissed'");
  const notBlocked = `
    NOT EXISTS (
      SELECT 1 FROM study_blocks
      WHERE (blocker_id = :account AND blocked_id = t.account_id)
        OR (blocker_id = t.account_id AND blocked_id = :account)
    )`;
  const partnerTicket = db.prepare(`
    SELECT t.id, t.region, t.status, t.expires_at, t.partner_ticket_id
    FROM study_match_tickets t
    WHERE t.id = :partner AND ${notBlocked}
  `);
  const candidates = db.prepare(`
    SELECT t.id, t.region
    FROM study_match_tickets t
    WHERE t.campus_id = :campus AND t.account_id <> :account AND t.status = 'searching'
      AND t.expires_at > :now AND ${notBlocked}
    ORDER BY t.started_at, t.id
  `);
  const insertTicket = db.prepare(`
    INSERT INTO study_match_tickets (id, account_id, campus_id, region, status, started_at, expires_at)
    VALUES (?, ?, ?, ?, 'searching', ?, ?)
  `);
  const offer = db.prepare(`
    UPDATE study_match_tickets SET status = 'found', partner_ticket_id = ?, expires_at = ? WHERE id = ?
  `);
  const acceptTicket = db.prepare("UPDATE study_match_tickets SET status = 'waiting' WHERE id = ?");
  const finishPair = db.prepare("UPDATE study_match_tickets SET status = 'matched', rendezvous_region = ? WHERE id IN (?, ?)");
  const chooseCafe = db.prepare('UPDATE study_match_tickets SET cafe_id = ? WHERE id IN (?, ?)');
  const expireOffer = db.prepare("UPDATE study_match_tickets SET expires_at = MIN(expires_at, ?) WHERE id = ? AND status IN ('found', 'waiting')");
  const dismissTicket = db.prepare("UPDATE study_match_tickets SET status = 'dismissed' WHERE id = ?");
  const renewTicket = db.prepare('UPDATE study_match_tickets SET expires_at = ? WHERE id = ?');
  // One student can dismiss or match again while the other keeps this result.
  const removeOldTickets = db.prepare(`
    DELETE FROM study_match_tickets AS t
    WHERE (t.status = 'dismissed' OR (t.status <> 'matched' AND t.expires_at < ?))
      AND NOT EXISTS (
        SELECT 1 FROM study_match_tickets kept WHERE kept.status = 'matched' AND kept.partner_ticket_id = t.id
      )
  `);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work(Date.now());
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function activePartner(ticket, now) {
    const partner = partnerTicket.get({ account: ticket.account_id, partner: ticket.partner_ticket_id });
    if (partner?.partner_ticket_id !== ticket.id) return null;
    if (ticket.status === 'matched') return partner;
    return partner.expires_at > now && ['found', 'waiting'].includes(partner.status) ? partner : null;
  }

  function stopLocation(ticketId) {
    const share = locationShares.get(ticketId);
    if (!share) return;
    clearTimeout(share.timer);
    locationShares.delete(ticketId);
  }

  function clearPairLocations(ticket) {
    stopLocation(ticket.id);
    stopLocation(ticket.partner_ticket_id);
  }

  function shareLocation(ticket, position, now, updating) {
    if (activePartner(ticket, now)?.status !== 'matched') {
      fail(409, '對方已離開這次配對，無法分享位置。');
    }

    const current = locationShares.get(ticket.id);
    if (updating) {
      if (!current || current.expiresAt <= now) fail(409, '位置分享已停止或到期，請重新開啟。');
      current.position = roundLocation(position);
      current.updatedAt = now;
      return;
    }

    if (current?.expiresAt > now) return;
    const rounded = roundLocation(position);
    stopLocation(ticket.id);
    const timer = setTimeout(() => locationShares.delete(ticket.id), LOCATION_SHARE_LIFETIME);
    timer.unref();
    locationShares.set(ticket.id, { position: rounded, expiresAt: now + LOCATION_SHARE_LIFETIME, updatedAt: now, timer });
  }

  function locationDetails(ticket, partner, now) {
    if (partner.status !== 'matched') return {};
    const own = locationShares.get(ticket.id);
    const peer = locationShares.get(partner.id);
    return {
      ...(own?.expiresAt > now ? { myLocationShare: { expiresAt: own.expiresAt } } : {}),
      ...(peer?.expiresAt > now ? { peerLocation: { position: peer.position, expiresAt: peer.expiresAt, updatedAt: peer.updatedAt } } : {}),
    };
  }

  function describe(ticket, now) {
    if (!ticket) return { status: 'idle' };
    const { id: ticketId, campus_id: campusId, region, status, started_at: startedAt, expires_at: expiresAt } = ticket;
    const info = { ticketId, campusId, region, startedAt, ...(status === 'matched' ? {} : { expiresAt }) };
    if (status !== 'matched' && expiresAt <= now) return { status: 'expired', reason: status === 'searching' ? 'search' : 'proposal', ...info };
    if (status === 'searching') return { status, ...info };

    const partner = activePartner(ticket, now);
    const campus = getCampus(campusId);
    const first = campusRegion(campus, region);
    const second = campusRegion(campus, partner?.region);
    if (!first || !second) {
      if (status === 'matched') clearPairLocations(ticket);
      return { status: 'expired', reason: 'proposal', ...info };
    }
    if (status !== 'matched') return { status, ...info };

    const savedVenue = campusRegion(campus, ticket.rendezvous_region);
    const venue = savedVenue?.placeType ? savedVenue : selectRendezvous(campus, first, second);
    if (!venue) return { status: 'expired', reason: 'proposal', ...info };
    const cafe = getCafeById(ticket.cafe_id);
    return {
      status,
      ...info,
      rendezvous: { name: venue.label, region: venue.name, position: venue.position },
      ...(cafe ? { cafe: { id: cafe.id, name: cafe.name, position: cafe.position } } : {}),
      ...locationDetails(ticket, partner, now),
    };
  }

  function chooseCandidate(account, campus, region, now) {
    let nearest;
    let nearestDistance = Infinity;
    for (const candidate of candidates.all({ account: account.id, campus: campus.id, now })) {
      const area = campusRegion(campus, candidate.region);
      if (!area) continue;
      const distance = markerDistance(region.position, area.position);
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function start(account, data, previous, now) {
    const campus = getCampus(data.campusId);
    const region = campusRegion(campus, data.region);
    if (!region) fail(400, '請選擇有效的校園和所在區域。');
    if (previous) dismissTicket.run(previous.id);
    const id = randomUUID();
    insertTicket.run(id, account.id, campus.id, region.name, now, now + SEARCH_LEASE);
    const candidate = chooseCandidate(account, campus, region, now);
    if (candidate) {
      offer.run(candidate.id, now + ACCEPT_LIMIT, id);
      offer.run(id, now + ACCEPT_LIMIT, candidate.id);
    }
  }

  function accept(ticket, now) {
    const partner = activePartner(ticket, now);
    if (partner.status === 'found') {
      acceptTicket.run(ticket.id);
      return;
    }
    const campus = getCampus(ticket.campus_id);
    const venue = selectRendezvous(campus, campusRegion(campus, ticket.region), campusRegion(campus, partner.region));
    if (!venue) {
      expireOffer.run(now, ticket.id);
      expireOffer.run(now, partner.id);
      return;
    }
    finishPair.run(venue.name, ticket.id, partner.id);
  }

  function exit(ticket, now) {
    expireOffer.run(now, ticket.partner_ticket_id);
    dismissTicket.run(ticket.id);
  }

  function handle(account, data) {
    if (account.role !== 'student') fail(403, '只有學生帳號可以使用即時匹配。');
    const { action, ticketId } = data;
    if (!ACTIONS.includes(action)) fail(400, '請選擇有效的匹配操作。');
    if (action !== 'check' && action !== 'start' && typeof ticketId !== 'string') fail(400, '找不到這次匹配。');

    return transaction(now => {
      removeOldTickets.run(now - EXPIRED_TICKET_RETENTION);
      const ticket = currentTicket.get(account.id);
      const result = describe(ticket, now);

      if (action === 'start' && ['idle', 'expired'].includes(result.status)) {
        start(account, data, ticket, now);
      } else if (action === 'check' || action === 'start') {
        if (result.status !== 'searching') return result;
        renewTicket.run(Math.min(now + SEARCH_LEASE, ticket.started_at + SEARCH_LIMIT), ticket.id);
      } else if (!ticket || ticket.id !== ticketId) {
        return result;
      } else if (action === 'accept' && result.status === 'found') {
        accept(ticket, now);
      } else if (action === 'select-cafe' && result.status === 'matched') {
        const cafe = getCafeById(data.cafeId);
        if (!cafe) fail(400, '請選擇地圖上的咖啡廳。');
        chooseCafe.run(cafe.id, ticket.id, ticket.partner_ticket_id);
      } else if ((action === 'share-location' || action === 'update-location') && result.status === 'matched') {
        shareLocation(ticket, data.position, now, action === 'update-location');
      } else if (action === 'stop-location') {
        stopLocation(ticket.id);
      } else if (action === 'cancel' && ['searching', 'found', 'waiting'].includes(result.status)) {
        exit(ticket, now);
      } else if (action === 'decline' && ['found', 'waiting'].includes(result.status)) {
        exit(ticket, now);
      } else if (action === 'dismiss' && ['expired', 'matched'].includes(result.status)) {
        clearPairLocations(ticket);
        dismissTicket.run(ticket.id);
      } else {
        return result;
      }

      return describe(currentTicket.get(account.id), now);
    });
  }

  function logout(account) {
    if (account.role !== 'student') return;
    transaction(now => {
      const ticket = currentTicket.get(account.id);
      if (!ticket) return;
      clearPairLocations(ticket);
      if (ticket.status !== 'matched') exit(ticket, now);
    });
  }

  return { handle, logout };
}
