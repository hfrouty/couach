import { icon } from './icons.mjs';
import { DEFAULT_CAMPUS_ID, getCampus } from './campuses.mjs';
import { markerDistance } from './matching.mjs';

const tileSize = 256;
const minZoom = 6;
const maxZoom = 18;
const minLatitude = -85.05112878;
const maxLatitude = 85.05112878;
const cafeClusterZoom = 17;
const cafeClusterSize = 48;
const taiwanBounds = { south: 21.7, west: 117.8, north: 26.6, east: 122.5 };
const cafePageSize = 35;
const nearbyDistance = 60;
const leaveNearbyDistance = 80;
const pairFreshness = 45_000;
const positionHeartbeat = 15_000;
const distanceFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 1 });
const tileSource = 'https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible';
const mapControllers = new WeakMap();
const placeKinds = {
  library: { label: '圖書館', glyph: 'library' },
  cafe: { label: '咖啡廳', glyph: 'cup' },
};
const markerRadius = 16;
const markerSides = [
  { side: 'below', x: 0, y: 18 },
  { side: 'above', x: 0, y: -18 },
  { side: 'left', x: -18, y: 0 },
  { side: 'right', x: 18, y: 0 },
  { side: 'below-left', x: -18, y: 18 },
  { side: 'below-right', x: 18, y: 18 },
  { side: 'above-left', x: -18, y: -18 },
  { side: 'above-right', x: 18, y: -18 },
];

export const DEFAULT_MAP_CAMPUS = getCampus(DEFAULT_CAMPUS_ID);

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function invitationCounts(invitations) {
  const counts = new Map();
  const now = Date.now();
  for (const invitation of invitations) {
    if (invitation.mode !== 'in-person' || invitation.closed || !(Date.parse(invitation.end) > now)) continue;
    counts.set(invitation.region, (counts.get(invitation.region) ?? 0) + 1);
  }
  return counts;
}

function regionButton(region, selectedRegion, count, marker = false) {
  const name = escape(region.name);
  const label = escape(region.label || region.name);
  const selected = region.name === selectedRegion;
  const attrs = `type="button" data-action="map-region" data-value="${name}" aria-pressed="${selected}"`;
  if (marker) {
    const [latitude, longitude] = region.position;
    return `<button ${attrs} class="campus-map-pin" data-map-pin
      data-latitude="${Number(latitude)}" data-longitude="${Number(longitude)}" tabindex="-1"
      aria-label="${name}，${count} 個邀約" title="${name}，${count} 個邀約">
      <span class="campus-map-pin-icon">${icon('pin')}</span>
      <span class="campus-map-pin-label">${label}</span><span class="campus-map-pin-count" data-map-region-count aria-hidden="true"${count ? '' : ' hidden'}>${count}</span>
    </button>`;
  }
  return `<button ${attrs} class="campus-region-button" aria-label="${name}，${count} 個邀約">
    ${name}<span class="campus-region-count" data-map-region-count aria-hidden="true"${count ? '' : ' hidden'}>${count}</span>
  </button>`;
}

function validPosition(position) {
  if (!Array.isArray(position) || position.length !== 2) return false;
  const [latitude, longitude] = position;
  return Number.isFinite(latitude) && latitude >= minLatitude && latitude <= maxLatitude
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function inTaiwan([latitude, longitude]) {
  return latitude >= taiwanBounds.south && latitude <= taiwanBounds.north
    && longitude >= taiwanBounds.west && longitude <= taiwanBounds.east;
}

export function walkingDirectionsURL(destination, origin) {
  const url = new URL('https://www.google.com/maps/dir/');
  url.search = new URLSearchParams({ api: '1', destination: destination.join(','), travelmode: 'walking' });
  if (origin) url.searchParams.set('origin', origin.join(','));
  else url.searchParams.set('dir_action', 'navigate');
  return url.href;
}

function placeMarker(place) {
  const [latitude, longitude] = place.position;
  const name = escape(place.name);
  const { label, glyph } = placeKinds[place.kind];
  return `<button type="button" class="campus-map-place-pin campus-map-place-kind" data-map-pin
    data-map-place="${escape(place.id)}" data-place-kind="${place.kind}" data-place-name="${name}"
    data-latitude="${latitude}" data-longitude="${longitude}"
    aria-pressed="false" aria-label="${name}（${label}）" tabindex="-1">${icon(glyph)}
    <span class="campus-map-place-label" aria-hidden="true">${name}</span>
  </button>`;
}

function placeFilters(places) {
  const kinds = Object.keys(placeKinds).filter(kind => kind === 'cafe' || places.some(place => place.kind === kind));
  return `<div class="campus-map-place-filters" role="group" aria-label="篩選地圖地點">
    <button type="button" class="campus-map-place-filter" data-map-place-filter="" aria-pressed="true">全部地點</button>
    ${kinds.map(kind => `<button type="button" class="campus-map-place-filter campus-map-place-kind"
      data-map-place-filter="${kind}" data-place-kind="${kind}" aria-pressed="false">${icon(placeKinds[kind].glyph)} ${placeKinds[kind].label}</button>`).join('')}
    <button type="button" class="campus-map-place-filter campus-map-national" data-map-command="taiwan-overview">${icon('map')} 全臺咖啡廳</button>
  </div>`;
}

function placeListItem({ id, name, position }, selected = false) {
  return `<li><button type="button" data-map-place="${escape(id)}" aria-pressed="${selected}">${escape(name)}</button>
    <a href="${escape(walkingDirectionsURL(position))}" target="_blank" rel="noopener noreferrer"
      aria-label="${escape(name)}的 Google 地圖步行路線">路線</a></li>`;
}

function placeList(places) {
  return `<section class="campus-map-places" aria-labelledby="campus-map-places-title">
    <h2 id="campus-map-places-title">周邊地點</h2>
    <div class="campus-map-place-groups">
      ${Object.entries(placeKinds).map(([kind, { label, glyph }]) => {
        const members = places.filter(place => place.kind === kind);
        if (kind === 'cafe') return `<div class="campus-map-place-group" data-map-place-group="cafe">
          <h3><span class="campus-map-legend-icon campus-map-place-kind" data-place-kind="cafe">${icon(glyph)}</span>此地圖範圍內的咖啡廳 <span class="campus-map-place-count" data-map-cafe-count></span></h3>
          <p class="campus-map-data-source" data-map-cafe-status role="status" hidden></p>
          <ul data-map-cafe-list></ul>
          <button type="button" class="campus-map-more-cafes" data-map-command="more-cafes" hidden>顯示更多咖啡廳</button>
        </div>`;
        if (!members.length) return '';
        return `<div class="campus-map-place-group" data-map-place-group="${kind}">
          <h3><span class="campus-map-legend-icon campus-map-place-kind" data-place-kind="${kind}">${icon(glyph)}</span>${label} <span class="campus-map-place-count">${members.length}</span></h3>
          <ul>${members.map(place => placeListItem(place)).join('')}</ul>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

export function renderCampusMap({
  selectedRegion = '', invitations = [], campus = DEFAULT_MAP_CAMPUS, actions = '', places = [],
  rendezvous, sharedCafe, matchCoordinates = false,
} = {}) {
  const [latitude, longitude] = campus.center;
  const counts = invitationCounts(invitations);
  const name = escape(campus.name);
  const landmarks = places.filter(place => Object.hasOwn(placeKinds, place.kind) && validPosition(place.position));
  const meeting = validPosition(rendezvous?.position) ? rendezvous : null;
  const startingCafes = landmarks.filter(place => place.kind === 'cafe');
  return `<section class="campus-map${matchCoordinates ? ' campus-map-live-match' : ''}" aria-labelledby="campus-map-title" data-campus-map data-campus-id="${escape(campus.id)}"
    data-starting-cafes="${escape(JSON.stringify(startingCafes))}" data-shared-cafe="${escape(JSON.stringify(sharedCafe ?? null))}">
    <header class="campus-map-header">
      <div>
        <p class="campus-map-school">${icon('pin')} ${name}${campus.area ? ` · ${escape(campus.area)}` : ''}</p>
        <h2 id="campus-map-title">${matchCoordinates ? '會合地圖' : '校園共讀地圖'}</h2>
        <p class="campus-map-instructions">${matchCoordinates ? '兩人分享位置後可查看彼此的直線距離。' : `點選共讀區域查看邀約${landmarks.length ? '，也可以查找圖書館與咖啡廳。' : '。'}`}</p>
      </div>
      ${actions ? `<div class="campus-map-actions">${actions}</div>` : ''}
    </header>
    ${matchCoordinates ? `<div class="campus-map-distance" data-map-pair-summary>
      <div><p>你們相距</p><strong data-map-pair-distance>尚待兩人分享位置</strong><p data-map-pair-stale hidden>以最近一次的位置估算。</p></div>
      <p class="sr-only" role="status" data-map-pair-announcement></p>
      <button type="button" data-map-command="fit-pair" hidden>${icon('compass')} 查看兩人位置</button>
    </div>
    <section class="campus-map-nearby" data-map-pair-nearby aria-labelledby="campus-map-nearby-title" hidden>
      <span class="campus-map-nearby-icon">${icon('users')}</span>
      <div>
        <h3 id="campus-map-nearby-title" tabindex="-1" data-map-nearby-title>你們目前在做什麼？</h3>
        <p data-map-nearby-note>定位顯示你們已靠近。碰面後，可以一起選一間咖啡廳。</p>
      </div>
      <button type="button" data-map-command="pair-met">${icon('check')} 我們已碰面</button>
    </section>` : ''}
    ${placeFilters(landmarks)}
    <div class="campus-map-route-summary" data-map-route-summary hidden>
      <p role="status" data-map-route-text></p>
      <div>
        <a data-map-route-directions target="_blank" rel="noopener noreferrer">Google 地圖步行導航</a>
        <button type="button" data-map-command="clear-route">清除路線</button>
      </div>
      <small>步行路線 <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener noreferrer">FOSSGIS</a> · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">回報道路資料</a></small>
    </div>
    <div class="campus-map-location-status" data-map-location-status hidden>
      <p role="status" data-map-location-text></p>
      <button type="button" data-map-command="stop-locate" hidden>停止定位</button>
    </div>
    <div class="campus-map-content campus-map-content-with-places">
      <div class="campus-map-surface">
        <div class="campus-map-viewport" data-map-viewport data-latitude="${Number(latitude)}" data-longitude="${Number(longitude)}"
          data-zoom="${Number(campus.zoom ?? 16)}" tabindex="0" role="group" aria-label="${name}周邊地圖"
          aria-describedby="campus-map-keyboard">
          <span class="sr-only" id="campus-map-keyboard">可用滑鼠滾輪縮放，或用方向鍵移動地圖、按加號或減號縮放。按 Tab 使用地圖控制或下方清單。</span>
          <div class="campus-map-tiles" data-map-tiles aria-hidden="true"></div>
          <canvas class="campus-map-route" data-map-route-line aria-hidden="true" hidden></canvas>
          ${matchCoordinates ? '<div class="campus-map-pair-line" data-map-pair-line aria-hidden="true" hidden></div>' : ''}
          <div class="campus-map-pins">
            ${matchCoordinates ? '' : campus.regions.map(region => regionButton(region, selectedRegion, counts.get(region.name) ?? 0, true)).join('')}
            ${landmarks.filter(place => place.kind !== 'cafe').map(placeMarker).join('')}
            <div data-map-cafe-pins></div>
            <div data-map-cafe-clusters></div>
            <button type="button" class="campus-map-meeting-pin" data-map-command="rendezvous" data-map-rendezvous
              ${meeting ? `data-name="${escape(meeting.name)}" data-latitude="${meeting.position[0]}" data-longitude="${meeting.position[1]}"` : ''}
              aria-label="共同集合點${meeting ? `：${escape(meeting.name)}` : ''}" hidden>${icon('pin')} 共同集合點</button>
            <span class="campus-map-location-pin" data-map-location aria-label="我的位置" role="img" hidden></span>
            <button type="button" class="campus-map-peer-pin" data-map-command="peer-location" data-map-peer
              aria-label="配對對象分享的位置" hidden>${icon('users')} ${matchCoordinates ? '對方的位置' : '對方分享的位置'}</button>
          </div>
          <div class="campus-map-controls" role="group" aria-label="地圖控制">
            <div class="campus-map-zoom-controls">
              <button type="button" data-map-command="zoom-in" aria-label="放大地圖" title="放大地圖">+</button>
              <button type="button" data-map-command="zoom-out" aria-label="縮小地圖" title="縮小地圖">−</button>
            </div>
            <button type="button" data-map-command="reset" aria-label="回到校園中心" title="回到校園中心">${icon('compass')}</button>
            <button type="button" data-map-command="locate" aria-label="定位我現在的位置" title="定位我現在的位置">${icon('pin')}</button>
          </div>
          <div class="campus-map-place-detail campus-map-place-kind" data-map-place-detail hidden>
            <span class="campus-map-legend-icon" data-map-detail-icon></span>
            <div>
              <strong data-map-detail-name></strong>
              <a data-map-detail-directions target="_blank" rel="noopener noreferrer">Google 地圖步行導航</a>
              <button type="button" class="campus-map-pick-cafe" data-action="choose-match-cafe" data-map-pick-cafe hidden>一起去這間</button>
            </div>
            <button type="button" data-map-command="close-place" aria-label="關閉地點資訊">${icon('close')}</button>
          </div>
          <p class="campus-map-error" data-map-error role="status" hidden>目前無法載入底圖，仍可使用標記與下方清單。</p>
          <div class="campus-map-attribution">
            <a href="https://maps.nlsc.gov.tw/S09SOA/homePage.action?Language=ZH" target="_blank" rel="noopener noreferrer">底圖 © 內政部國土測繪中心</a>
          </div>
        </div>
        <div class="campus-map-footer">
          <p class="campus-map-wheel-hint">在地圖上滾動滑鼠滾輪可縮放</p>
          <ul class="campus-map-legend" aria-label="地圖圖例">
            ${matchCoordinates ? '' : `<li><span class="campus-map-legend-icon">${icon('pin')}</span>共讀區域</li>`}
            <li data-map-meeting-legend${meeting ? '' : ' hidden'}><span class="campus-map-legend-icon campus-map-meeting-legend">${icon('pin')}</span>共同集合點</li>
            <li data-map-peer-legend hidden><span class="campus-map-legend-icon campus-map-peer-legend">${icon('users')}</span>對方分享的位置</li>
            ${matchCoordinates ? '<li data-map-own-legend hidden><span class="campus-map-own-key"></span>我的位置</li>' : ''}
            ${Object.entries(placeKinds).filter(([kind]) => kind === 'cafe' || landmarks.some(place => place.kind === kind)).map(([kind, { label, glyph }]) =>
              `<li data-map-place-legend="${kind}"><span class="campus-map-legend-icon campus-map-place-kind" data-place-kind="${kind}">${icon(glyph)}</span>${label}</li>`).join('')}
          </ul>
          <p class="campus-map-data-source">移動或縮放可查看全臺收錄的咖啡廳。地點資料 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap 貢獻者</a></p>
          ${matchCoordinates ? '' : `<div class="campus-region-list" role="group" aria-label="依校園區域篩選">
            <button type="button" class="campus-region-button" data-action="map-region" data-value=""
              aria-pressed="${!selectedRegion}">所有區域</button>
            ${campus.regions.map(region => regionButton(region, selectedRegion, counts.get(region.name) ?? 0)).join('')}
          </div>`}
        </div>
      </div>
      ${placeList(landmarks)}
    </div>
  </section>`;
}

export function viewCampusDestination(root, options = {}) {
  return mapControllers.get(root.querySelector('[data-campus-map]'))?.viewDestination(options);
}

export function showCampusWalkingRoute(root, options) {
  return mapControllers.get(root.querySelector('[data-campus-map]'))?.showRoute(options);
}

export function clearCampusWalkingRoute(root) {
  mapControllers.get(root.querySelector('[data-campus-map]'))?.clearRoute();
}

export function locateCampusPosition(root, options) {
  return mapControllers.get(root.querySelector('[data-campus-map]'))?.locateDevice(options);
}

export function showCampusCafes(root) {
  const filter = root.querySelector('[data-map-place-filter="cafe"]');
  filter?.click();
  filter?.focus({ preventScroll: true });
  return filter;
}

export function updateCampusMapSelection(root, selectedRegion = '', invitations) {
  const counts = invitations && invitationCounts(invitations);
  for (const button of root.querySelectorAll('[data-campus-map] [data-action="map-region"]')) {
    const region = button.dataset.value;
    button.setAttribute('aria-pressed', String(region === selectedRegion));
    const badge = button.querySelector('[data-map-region-count]');
    if (!counts || !badge) continue;
    const count = counts.get(region) ?? 0;
    badge.textContent = String(count);
    badge.hidden = count === 0;
    const label = `${region}，${count} 個邀約`;
    button.setAttribute('aria-label', label);
    if (button.hasAttribute('title')) button.title = label;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function worldPoint(latitude, longitude, zoom) {
  const radians = clamp(latitude, minLatitude, maxLatitude) * Math.PI / 180;
  const worldSize = tileSize * 2 ** zoom;
  return {
    x: (longitude + 180) / 360 * worldSize,
    y: (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * worldSize,
  };
}

function geographicPoint(x, y, zoom) {
  const worldSize = tileSize * 2 ** zoom;
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y / worldSize))) * 180 / Math.PI, 360 * x / worldSize - 180];
}

function viewCafeBounds(zoom, left, top, width, height) {
  const unit = tileSize * 2 ** Math.max(0, zoom - 13);
  const [north, west] = geographicPoint(Math.floor(left / unit) * unit, Math.floor(top / unit) * unit, zoom);
  const [south, east] = geographicPoint(Math.ceil((left + width) / unit) * unit, Math.ceil((top + height) / unit) * unit, zoom);
  return [
    Math.max(taiwanBounds.south, south), Math.max(taiwanBounds.west, west),
    Math.min(taiwanBounds.north, north), Math.min(taiwanBounds.east, east),
  ];
}

function containsBounds(outer, inner) {
  return outer && outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function visibleCafes(places, zoom, left, top, width, height, featuredIds) {
  const members = [];
  const groups = new Map();
  for (const cafe of places.values()) {
    const point = worldPoint(...cafe.position, zoom);
    const x = point.x - left;
    const y = point.y - top;
    if (x < 0 || y < 0 || x > width || y > height) continue;
    const member = { cafe, x, y, distance: (x - width / 2) ** 2 + (y - height / 2) ** 2 };
    members.push(member);
    if (zoom >= cafeClusterZoom || featuredIds.includes(cafe.id)) continue;
    const key = `${zoom}/${Math.floor(point.x / cafeClusterSize)}/${Math.floor(point.y / cafeClusterSize)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(member);
  }
  const clusters = [];
  const groupedIds = new Set();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    let x = 0;
    let y = 0;
    for (const member of group) {
      groupedIds.add(member.cafe.id);
      x += member.x;
      y += member.y;
    }
    clusters.push({ key, count: group.length, x: x / group.length, y: y / group.length });
  }
  return { members, clusters, groupedIds };
}

function positionPins(pins, zoom, left, top, width, height) {
  const positioned = pins.map(button => {
    const point = worldPoint(Number(button.dataset.latitude), Number(button.dataset.longitude), zoom);
    return { button, x: point.x - left, y: point.y - top };
  });
  const visible = positioned.filter(({ button, x, y }) => {
    button.hidden = x < 0 || y < 0 || x > width || y > height;
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    return !button.hidden;
  });
  const occupied = [];
  const compact = [];

  // Give full region labels room. In crowded areas reveal each name on hover, focus or selection.
  for (const pin of visible) {
    const isPlace = pin.button.hasAttribute('data-map-place');
    const crowded = !isPlace && (width < 440 || visible.some(other => other !== pin
      && Math.abs(pin.x - other.x) < 100 && Math.abs(pin.y - other.y) < 60));
    pin.button.classList.toggle('campus-map-pin-compact', !isPlace && crowded);
    if (isPlace || crowded) {
      compact.push({ ...pin, preferredSide: isPlace ? 'above' : 'below' });
      continue;
    }
    occupied.push({ x: pin.x, y: pin.y + 18 });
    pin.button.dataset.mapSide = 'below';
  }

  // Keep each marker anchored to its coordinates and use another side when its icon would overlap.
  for (const pin of compact) {
    let best;
    for (const { side, x, y } of markerSides) {
      const point = { x: pin.x + x, y: pin.y + y };
      const edge = Math.min(point.x, point.y, width - point.x, height - point.y);
      const spacing = Math.min(edge * 2, ...occupied.map(other => Math.hypot(point.x - other.x, point.y - other.y)));
      const score = Math.min(spacing, markerRadius * 2) + (side === pin.preferredSide ? .01 : 0);
      if (!best || score > best.score) best = { side, point, score };
    }
    occupied.push(best.point);
    pin.button.dataset.mapSide = best.side;
  }
}

export function bindCampusMap(root) {
  const viewport = root.querySelector('[data-map-viewport]');
  if (!viewport) return () => {};

  const tiles = viewport.querySelector('[data-map-tiles]');
  const clusterLayer = viewport.querySelector('[data-map-cafe-clusters]');
  const clusterButtons = new Map();
  const cafeLayer = viewport.querySelector('[data-map-cafe-pins]');
  const cafePins = new Map();
  const cafeCache = new Map();
  const error = viewport.querySelector('[data-map-error]');
  const pins = [...viewport.querySelectorAll('[data-map-pin]')];
  const map = viewport.closest('[data-campus-map]');
  const placePins = new Map(pins.filter(pin => pin.hasAttribute('data-map-place')).map(pin => [pin.dataset.mapPlace, pin]));
  const startupCafes = new Map(JSON.parse(map.dataset.startingCafes).map(cafe => [cafe.id, cafe]));
  delete map.dataset.startingCafes;
  const cafeList = map.querySelector('[data-map-cafe-list]');
  const cafeCount = map.querySelector('[data-map-cafe-count]');
  const cafeStatus = map.querySelector('[data-map-cafe-status]');
  const moreCafes = map.querySelector('[data-map-command="more-cafes"]');
  const filterButtons = [...map.querySelectorAll('[data-map-place-filter]')];
  const placeGroups = [...map.querySelectorAll('[data-map-place-group]')];
  const placeLegends = [...map.querySelectorAll('[data-map-place-legend]')];
  const detail = viewport.querySelector('[data-map-place-detail]');
  const detailIcon = detail?.querySelector('[data-map-detail-icon]');
  const detailName = detail?.querySelector('[data-map-detail-name]');
  const detailDirections = detail?.querySelector('[data-map-detail-directions]');
  const pickCafe = detail.querySelector('[data-map-pick-cafe]');
  const meetingPin = viewport.querySelector('[data-map-rendezvous]');
  const meetingLegend = map.querySelector('[data-map-meeting-legend]');
  const peerPin = viewport.querySelector('[data-map-peer]');
  const peerLegend = map.querySelector('[data-map-peer-legend]');
  const pairLine = viewport.querySelector('[data-map-pair-line]');
  const pairDistance = map.querySelector('[data-map-pair-distance]');
  const pairStale = map.querySelector('[data-map-pair-stale]');
  const pairAnnouncement = map.querySelector('[data-map-pair-announcement]');
  const fitPair = map.querySelector('[data-map-command="fit-pair"]');
  const ownLegend = map.querySelector('[data-map-own-legend]');
  const nearby = map.querySelector('[data-map-pair-nearby]');
  const nearbyTitle = nearby?.querySelector('[data-map-nearby-title]');
  const nearbyNote = nearby?.querySelector('[data-map-nearby-note]');
  const metButton = nearby?.querySelector('[data-map-command="pair-met"]');
  const locationPin = viewport.querySelector('[data-map-location]');
  const locationStatus = map.querySelector('[data-map-location-status]');
  const locationText = locationStatus.querySelector('[data-map-location-text]');
  const stopLocation = locationStatus.querySelector('[data-map-command="stop-locate"]');
  const routeLine = viewport.querySelector('[data-map-route-line]');
  const routeSummary = map.querySelector('[data-map-route-summary]');
  const routeText = routeSummary.querySelector('[data-map-route-text]');
  const routeDirections = routeSummary.querySelector('[data-map-route-directions]');
  const zoomIn = viewport.querySelector('[data-map-command="zoom-in"]');
  const zoomOut = viewport.querySelector('[data-map-command="zoom-out"]');
  const coordinates = [Number(viewport.dataset.latitude), Number(viewport.dataset.longitude)];
  const defaultZoom = clamp(Number(viewport.dataset.zoom), minZoom, maxZoom);
  const tileEntries = new Map();
  const pointers = new Map();
  const events = new AbortController();
  const options = { signal: events.signal };
  let visiblePins = pins;
  let placeKindFilter = '';
  let zoom = fitZoom();
  let center = worldPoint(...coordinates, zoom);
  let frame = 0;
  let atCampusOverview = true;
  let selectedPlaceTrigger;
  let pinchDistance = 0;
  let lastWheelAt = 0;
  let wheelDelta = 0;
  let meeting = meetingPin.dataset.name ? {
    name: meetingPin.dataset.name,
    position: [Number(meetingPin.dataset.latitude), Number(meetingPin.dataset.longitude)],
  } : null;
  let sharedCafe = JSON.parse(map.dataset.sharedCafe);
  let peer;
  let peerExpiry;
  let myShare;
  let ownExpiry;
  let freshnessTimer;
  let livePair = false;
  let pairFitted = false;
  let isNearby = false;
  let hasMet = false;
  let selectedCafe;
  let activeCafes = startupCafes;
  let loadedBounds;
  let pendingCafeKey = '';
  let cafeRequest;
  let cafeTimer;
  let cafeRetryAfter = 0;
  let cafeMessage = '';
  let cafeLimit = cafePageSize;
  let cafeListKey = '';
  let location;
  let deviceFix;
  let locationWatch = null;
  let locationHeartbeat;
  let locationGeneration = 0;
  let routePoints = [];
  let routeRequest;

  function fitZoom() {
    const halfWidth = Math.max(0, viewport.clientWidth / 2 - 55);
    const halfHeight = Math.max(0, viewport.clientHeight / 2 - 50);
    if (!placePins.size || !halfWidth || !halfHeight) return defaultZoom;
    for (let level = defaultZoom; level > 13; level -= 1) {
      const midpoint = worldPoint(...coordinates, level);
      const fits = visiblePins.every(pin => {
        const position = worldPoint(Number(pin.dataset.latitude), Number(pin.dataset.longitude), level);
        return Math.abs(position.x - midpoint.x) <= halfWidth && Math.abs(position.y - midpoint.y) <= halfHeight;
      });
      if (fits) return level;
    }
    return 13;
  }

  function setCenter(x, y) {
    const topLeft = worldPoint(taiwanBounds.north, taiwanBounds.west, zoom);
    const bottomRight = worldPoint(taiwanBounds.south, taiwanBounds.east, zoom);
    atCampusOverview = false;
    center = { x: clamp(x, topLeft.x, bottomRight.x), y: clamp(y, topLeft.y, bottomRight.y) };
    scheduleDraw();
  }

  function viewportPoint(clientX, clientY) {
    const bounds = viewport.getBoundingClientRect();
    return { x: clientX - bounds.left - viewport.clientLeft, y: clientY - bounds.top - viewport.clientTop };
  }

  function changeZoom(offset, point) {
    const next = clamp(zoom + offset, minZoom, maxZoom);
    if (next === zoom) return;
    const scale = 2 ** (next - zoom);
    const x = point ? point.x - viewport.clientWidth / 2 : 0;
    const y = point ? point.y - viewport.clientHeight / 2 : 0;
    zoom = next;
    setCenter((center.x + x) * scale - x, (center.y + y) * scale - y);
  }

  function resetView() {
    atCampusOverview = true;
    zoom = fitZoom();
    center = worldPoint(...coordinates, zoom);
    scheduleDraw();
  }

  function selectPlace(button) {
    const placeId = button.dataset.mapPlace;
    const cafe = cafeForId(placeId);
    if (cafe) {
      selectedCafe = cafe;
      showPlaceDetail(button, 'cafe', cafe.name, cafe.position, placeId);
      centerOn(cafe.position);
      return;
    }
    const pin = placePins.get(placeId);
    if (!pin) return;
    const { latitude, longitude, placeName, placeKind } = pin.dataset;
    const position = [Number(latitude), Number(longitude)];
    showPlaceDetail(button, placeKind, placeName, position, placeId);
    centerOn(position);
  }

  function centerOn(position) {
    const point = worldPoint(...position, zoom);
    setCenter(point.x, point.y);
  }

  function showPlaceDetail(trigger, kind, name, position, placeId = '') {
    selectedPlaceTrigger = trigger;
    if (kind !== 'cafe') selectedCafe = null;
    for (const item of map.querySelectorAll('[data-map-place]')) item.setAttribute('aria-pressed', String(item.dataset.mapPlace === placeId));
    detail.dataset.placeKind = kind;
    detailIcon.innerHTML = icon(kind === 'peer' ? 'users' : placeKinds[kind]?.glyph ?? 'pin');
    detailName.textContent = name;
    detailDirections.href = walkingDirectionsURL(position, kind === 'cafe' ? meeting?.position : undefined);
    detailDirections.setAttribute('aria-label', `${name}的 Google 地圖步行導航`);
    pickCafe.hidden = !(kind === 'cafe' && meeting);
    pickCafe.dataset.value = placeId;
    detail.hidden = false;
  }

  function closePlace(restoreFocus = false) {
    if (!detail || detail.hidden) return;
    detail.hidden = true;
    detailDirections.removeAttribute('href');
    selectedCafe = null;
    for (const button of map.querySelectorAll('[data-map-place][aria-pressed="true"]')) button.setAttribute('aria-pressed', 'false');
    if (restoreFocus) (selectedPlaceTrigger?.isConnected && !selectedPlaceTrigger.hidden ? selectedPlaceTrigger : viewport).focus({ preventScroll: true });
    selectedPlaceTrigger = undefined;
    scheduleDraw();
  }

  function filterPlaces(filter) {
    if (filter.getAttribute('aria-pressed') === 'true') return;
    const kind = filter.dataset.mapPlaceFilter;
    placeKindFilter = kind;
    closePlace();
    visiblePins = pins.filter(pin => {
      const keep = !kind || !pin.dataset.placeKind || pin.dataset.placeKind === kind;
      if (!keep) pin.hidden = true;
      return keep;
    });
    for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.mapPlaceFilter === kind));
    for (const group of placeGroups) group.hidden = Boolean(kind && group.dataset.mapPlaceGroup !== kind);
    for (const legend of placeLegends) legend.hidden = Boolean(kind && legend.dataset.mapPlaceLegend !== kind);
    scheduleDraw();
  }

  function cafeForId(id) {
    if (sharedCafe?.id === id) return sharedCafe;
    if (selectedCafe?.id === id) return selectedCafe;
    return activeCafes.get(id) ?? startupCafes.get(id);
  }

  function setPeerLocation(next) {
    clearTimeout(peerExpiry);
    peer = validPosition(next?.position) && next.expiresAt > Date.now() ? next : null;
    peerLegend.hidden = !peer;
    if (!peer && detail.dataset.placeKind === 'peer') closePlace();
    if (peer) {
      if (!detail.hidden && detail.dataset.placeKind === 'peer') detailDirections.href = walkingDirectionsURL(peer.position);
      peerExpiry = setTimeout(() => { setPeerLocation(null); refreshPairView(); }, peer.expiresAt - Date.now());
    }
  }

  function pairPoints(now = Date.now()) {
    if (!pairLine || !livePair || !location || !inTaiwan(location) || !(myShare?.expiresAt > now)
      || !(peer?.expiresAt > now) || !inTaiwan(peer.position)) return [];
    return [location, peer.position];
  }

  function refreshPairView() {
    const points = pairPoints();
    clearTimeout(freshnessTimer);
    const freshUntil = Math.min(deviceFix?.capturedAt ?? 0, peer?.updatedAt ?? 0) + pairFreshness;
    if (points.length && freshUntil > Date.now()) freshnessTimer = setTimeout(scheduleDraw, freshUntil - Date.now());
    if (!points.length) pairFitted = false;
    if (points.length && !pairFitted && viewport.clientWidth && viewport.clientHeight) {
      pairFitted = true;
      fitPoints(points);
    }
    scheduleDraw();
  }

  function viewDestination({ rendezvous, cafe, peerLocation, myLocationShare, livePair: showLivePair = false, localPosition, focus, cafeOnly = false }) {
    const hadMeeting = Boolean(meeting);
    meeting = validPosition(rendezvous?.position) ? rendezvous : null;
    meetingLegend.hidden = !meeting;
    meetingPin.setAttribute('aria-label', meeting ? `共同集合點：${meeting.name}` : '共同集合點');
    if (hadMeeting && !meeting) closePlace();
    if (meeting) pickCafe.hidden = detail.dataset.placeKind !== 'cafe';
    sharedCafe = cafe ?? null;
    setPeerLocation(peerLocation);
    livePair = showLivePair;
    myShare = myLocationShare;
    if (showLivePair && !deviceFix && validPosition(localPosition) && inTaiwan(localPosition)) location = localPosition;
    clearTimeout(ownExpiry);
    if (myShare?.expiresAt > Date.now()) ownExpiry = setTimeout(refreshPairView, myShare.expiresAt - Date.now());
    if (cafeOnly) {
      const filter = filterButtons.find(button => button.dataset.mapPlaceFilter === 'cafe');
      if (filter) filterPlaces(filter);
    }
    if (focus === 'rendezvous' && meeting) {
      showPlaceDetail(meetingPin, 'rendezvous', meeting.name, meeting.position);
      centerOn(meeting.position);
    }
    if (focus === 'cafe' && cafe) {
      selectedCafe = cafe;
      showPlaceDetail(cafePins.get(cafe.id), 'cafe', cafe.name, cafe.position, cafe.id);
      centerOn(cafe.position);
    }
    if (focus === 'peer' && peer) {
      const onMap = inTaiwan(peer.position);
      showPlaceDetail(peerPin, 'peer', onMap ? '配對對象分享的位置' : '對方在臺灣底圖範圍外', peer.position);
      if (onMap) {
        zoom = Math.max(15, zoom);
        centerOn(peer.position);
      }
    }
    if (focus && pairPoints().length) pairFitted = true;
    refreshPairView();
    return viewport;
  }

  function clearRoute() {
    routeRequest?.abort();
    routeRequest = undefined;
    routePoints = [];
    routeSummary.hidden = true;
    routeLine.hidden = true;
  }

  function fitPoints(points) {
    const padding = 72;
    const availableWidth = Math.max(viewport.clientWidth - padding, 0);
    const availableHeight = Math.max(viewport.clientHeight - padding, 0);
    for (let level = maxZoom; level >= minZoom; level--) {
      const projected = points.map(point => worldPoint(...point, level));
      const left = Math.min(...projected.map(point => point.x));
      const right = Math.max(...projected.map(point => point.x));
      const top = Math.min(...projected.map(point => point.y));
      const bottom = Math.max(...projected.map(point => point.y));
      if (level > minZoom && (right - left > availableWidth || bottom - top > availableHeight)) continue;
      zoom = level;
      setCenter((left + right) / 2, (top + bottom) / 2);
      return;
    }
  }

  async function showRoute({ campusId, fromRegion, toRegion, cafeId, accountId }) {
    if (campusId !== map.dataset.campusId) return viewport;
    const campus = getCampus(campusId);
    const from = campus.regions.find(region => region.name === fromRegion)?.position;
    const to = cafeId ? cafeForId(cafeId)?.position : campus.regions.find(region => region.name === toRegion)?.position;
    if (!from || !to) return viewport;

    clearRoute();
    closePlace();
    routeSummary.hidden = false;
    routeText.textContent = '正在規劃步行路線…';
    routeDirections.href = walkingDirectionsURL(to, cafeId ? from : undefined);
    const request = new AbortController();
    routeRequest = request;
    try {
      const response = await fetch('/api/study/walking-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(accountId ? { 'X-StudyMate-Account': accountId } : {}) },
        body: JSON.stringify({ campusId, fromRegion, toRegion, cafeId }), signal: request.signal,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.points) throw new Error(result?.error ?? '目前無法取得步行路線。');
      if (routeRequest !== request) return viewport;
      routePoints = result.distance ? result.points : [];
      routeText.textContent = result.distance ? `步行約 ${Math.max(1, Math.ceil(result.seconds / 60))} 分鐘 · ${result.distance.toLocaleString('zh-TW')} 公尺（從${fromRegion}出發）` : '出發區域就在集合點附近，可依標記前往。';
      if (result.distance) fitPoints(routePoints);
      else centerOn(to);
    } catch (error) {
      if (routeRequest === request) routeText.textContent = `${error.message || '目前無法取得步行路線。'} 可開啟 Google 地圖導航。`;
    }
    return viewport;
  }

  function stopLocating(message = '') {
    locationGeneration++;
    clearInterval(locationHeartbeat);
    if (locationWatch !== null) navigator.geolocation.clearWatch?.(locationWatch);
    locationWatch = null;
    location = undefined;
    deviceFix = undefined;
    stopLocation.hidden = true;
    locationStatus.hidden = !message;
    locationText.textContent = message;
    refreshPairView();
  }

  function notifyLocation(event, detail) {
    map.dispatchEvent(new CustomEvent(`studymate:device-location${event}`, { bubbles: true, detail }));
  }

  function locateDevice({ recenter = true } = {}) {
    locationStatus.hidden = false;
    if (!navigator.geolocation?.watchPosition) {
      locationText.textContent = '這個瀏覽器無法顯示位置。';
      notifyLocation('-error', { code: 'unsupported' });
      return viewport;
    }
    if (locationWatch !== null) {
      if (location && recenter) centerOn(location);
      if (deviceFix) notifyLocation('', deviceFix);
      return viewport;
    }
    locationText.textContent = '正在定位…';
    stopLocation.hidden = false;
    const generation = ++locationGeneration;
    function applyFix({ coords, timestamp }) {
      if (events.signal.aborted || generation !== locationGeneration) return;
      if (Number.isFinite(timestamp) && timestamp < (deviceFix?.capturedAt ?? 0)) return;
      const { latitude, longitude } = coords;
      if (!inTaiwan([latitude, longitude])) {
        location = undefined;
        deviceFix = undefined;
        locationText.textContent = '你目前在臺灣底圖範圍外。';
        notifyLocation('-error', { code: 'outside-map' });
        refreshPairView();
        return;
      }
      const firstFix = !deviceFix;
      location = [latitude, longitude];
      deviceFix = { position: location, accuracy: coords.accuracy, capturedAt: timestamp ?? Date.now() };
      locationText.textContent = pairLine ? '藍點是我的即時位置。' : '藍點是我的即時位置，只顯示在這台裝置。';
      if (firstFix && recenter) {
        zoom = Math.max(15, zoom);
        centerOn(location);
      }
      notifyLocation('', deviceFix);
      refreshPairView();
    }
    locationWatch = navigator.geolocation.watchPosition(applyFix, error => {
      if (events.signal.aborted || generation !== locationGeneration) return;
      if (error.code === 1) stopLocating('請在瀏覽器允許本網站定位，再按一次定位。');
      else locationText.textContent = '正在等候定位訊號…';
      notifyLocation('-error', { code: error.code });
    }, { enableHighAccuracy: true, timeout: 8_000, maximumAge: 10_000 });
    if (pairLine) locationHeartbeat = setInterval(() => {
      const now = Date.now();
      if (!(myShare?.expiresAt > now) || document.visibilityState !== 'visible'
        || now - (deviceFix?.capturedAt ?? 0) < positionHeartbeat - 1_000) return;
      navigator.geolocation.getCurrentPosition?.(applyFix, () => {}, { enableHighAccuracy: true, timeout: 6_000, maximumAge: 3_000 });
    }, positionHeartbeat);
    return viewport;
  }

  function applyCafeCatalog(key, bounds, places) {
    activeCafes = new Map(places.map(place => [place.id, place]));
    loadedBounds = bounds;
    pendingCafeKey = '';
    cafeMessage = '';
    cafeCache.set(key, places);
    if (cafeCache.size > 10) cafeCache.delete(cafeCache.keys().next().value);
    scheduleDraw();
  }

  function ensureCafeCatalog(bounds) {
    if (containsBounds(loadedBounds, bounds)) {
      if (pendingCafeKey) {
        clearTimeout(cafeTimer);
        cafeRequest?.abort();
        pendingCafeKey = '';
        cafeMessage = '';
      }
      return;
    }
    if (Date.now() < cafeRetryAfter) return;
    if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) return;
    const key = bounds.join(',');
    if (pendingCafeKey === key) return;
    clearTimeout(cafeTimer);
    cafeRequest?.abort();
    const cached = cafeCache.get(key);
    if (cached) {
      applyCafeCatalog(key, bounds, cached);
      return;
    }
    pendingCafeKey = key;
    cafeMessage = '正在載入此地圖範圍的咖啡廳…';
    cafeTimer = setTimeout(async () => {
      const controller = new AbortController();
      cafeRequest = controller;
      try {
        const response = await fetch(`/api/cafes?${new URLSearchParams({ bbox: key })}`, { credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error();
        const { cafes } = await response.json();
        if (pendingCafeKey !== key || controller.signal.aborted) return;
        applyCafeCatalog(key, bounds, cafes.filter(cafe => typeof cafe.id === 'string' && validPosition(cafe.position)));
      } catch {
        if (controller.signal.aborted || pendingCafeKey !== key) return;
        pendingCafeKey = '';
        cafeRetryAfter = Date.now() + 4_000;
        cafeMessage = '暫時無法載入此範圍的完整咖啡廳資料。';
        scheduleDraw();
      }
    }, 180);
  }

  function drawCafeMarkers(members, groupedIds) {
    const visibleIds = new Set();
    for (const { cafe } of members) {
      if (groupedIds.has(cafe.id)) continue;
      visibleIds.add(cafe.id);
      let button = cafePins.get(cafe.id);
      if (!button) {
        cafeLayer.insertAdjacentHTML('beforeend', placeMarker({ ...cafe, kind: 'cafe' }));
        button = cafeLayer.lastElementChild;
        cafePins.set(cafe.id, button);
      }
      button.classList.toggle('campus-map-shared-cafe', cafe.id === sharedCafe?.id);
      button.setAttribute('aria-pressed', String(cafe.id === selectedCafe?.id));
    }
    for (const [id, button] of cafePins) {
      if (visibleIds.has(id)) continue;
      button.remove();
      cafePins.delete(id);
    }
  }

  function drawCafeList(members) {
    const shown = members.sort((a, b) => a.distance - b.distance).slice(0, cafeLimit);
    const key = shown.map(({ cafe }) => cafe.id).join(',');
    if (key !== cafeListKey) {
      cafeList.innerHTML = shown.map(({ cafe }) => placeListItem(cafe, cafe.id === selectedCafe?.id)).join('');
      cafeListKey = key;
    }
    cafeCount.textContent = members.length.toLocaleString('zh-TW');
    const message = cafeMessage || (!members.length ? '此地圖範圍沒有收錄的咖啡廳。' : '');
    if (cafeStatus.textContent !== message) cafeStatus.textContent = message;
    cafeStatus.hidden = !message;
    moreCafes.hidden = members.length <= cafeLimit;
  }

  function taiwanOverview() {
    const filter = filterButtons.find(button => button.dataset.mapPlaceFilter === 'cafe');
    if (filter) filterPlaces(filter);
    const { south, west, north, east } = taiwanBounds;
    for (let level = 8; level >= minZoom; level--) {
      const first = worldPoint(north, west, level);
      const last = worldPoint(south, east, level);
      if (level > minZoom && (last.x - first.x > viewport.clientWidth - 38 || last.y - first.y > viewport.clientHeight - 38)) continue;
      zoom = level;
      setCenter((first.x + last.x) / 2, (first.y + last.y) / 2);
      return;
    }
  }

  function updateTileStatus() {
    error.hidden = !tileEntries.size || ![...tileEntries.values()].every(tile => tile.failed);
  }

  function createTile(tileX, tileY) {
    const image = document.createElement('img');
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    image.referrerPolicy = 'origin';
    const tile = { image, failed: false };
    image.addEventListener('error', () => {
      tile.failed = true;
      image.hidden = true;
      updateTileStatus();
    }, options);
    image.src = `${tileSource}/${zoom}/${tileY}/${tileX}`;
    tiles.append(image);
    return tile;
  }

  function positionSpecialPin(pin, position, left, top, width, height) {
    if (!position) {
      pin.hidden = true;
      return;
    }
    const point = worldPoint(...position, zoom);
    const x = point.x - left;
    const y = point.y - top;
    pin.hidden = x < 0 || y < 0 || x > width || y > height;
    pin.style.left = `${x}px`;
    pin.style.top = `${y}px`;
  }

  function drawClusters(clusters, left, top) {
    const keys = new Set();
    for (const { key, count, x, y } of clusters) {
      keys.add(key);
      let button = clusterButtons.get(key);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'campus-map-cafe-cluster';
        button.dataset.mapCommand = 'cafe-cluster';
        button.tabIndex = -1;
        button.innerHTML = `${icon('cup')}<span></span>`;
        clusterButtons.set(key, button);
        clusterLayer.append(button);
      }
      button.querySelector('span').textContent = count;
      button.setAttribute('aria-label', `${count} 間咖啡廳，放大查看`);
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      button.dataset.worldX = x + left;
      button.dataset.worldY = y + top;
    }
    for (const [key, button] of clusterButtons) {
      if (keys.has(key)) continue;
      button.remove();
      clusterButtons.delete(key);
    }
  }

  function drawRoute(left, top, width, height) {
    routeLine.hidden = routePoints.length < 2;
    if (routeLine.hidden) return;
    const scale = window.devicePixelRatio || 1;
    const canvasWidth = Math.round(width * scale);
    const canvasHeight = Math.round(height * scale);
    if (routeLine.width !== canvasWidth) routeLine.width = canvasWidth;
    if (routeLine.height !== canvasHeight) routeLine.height = canvasHeight;
    const context = routeLine.getContext('2d');
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    for (const [index, point] of routePoints.entries()) {
      const projected = worldPoint(...point, zoom);
      (index ? context.lineTo : context.moveTo).call(context, projected.x - left, projected.y - top);
    }
    context.strokeStyle = '#fff';
    context.lineWidth = 8;
    context.stroke();
    context.strokeStyle = '#1562aa';
    context.lineWidth = 5;
    context.stroke();
  }

  function drawLivePair(left, top) {
    if (!pairLine) return;
    ownLegend.hidden = !location;
    const points = pairPoints();
    pairLine.hidden = fitPair.hidden = points.length !== 2;
    if (pairLine.hidden) {
      if (pairDistance.textContent !== '尚待兩人分享位置') pairDistance.textContent = '尚待兩人分享位置';
      isNearby = false;
      nearby.hidden = true;
      pairStale.hidden = true;
      pairAnnouncement.textContent = '';
      return;
    }

    const [start, end] = points.map(point => worldPoint(...point, zoom));
    const x = end.x - start.x;
    const y = end.y - start.y;
    pairLine.style.left = `${start.x - left}px`;
    pairLine.style.top = `${start.y - top}px`;
    pairLine.style.width = `${Math.max(2, Math.hypot(x, y))}px`;
    pairLine.style.transform = `translateY(-50%) rotate(${Math.atan2(y, x)}rad)`;

    const metres = markerDistance(...points);
    const label = metres < 10 ? '不到 10 公尺' : metres < 1_000
      ? `約 ${Math.round(metres)} 公尺` : `約 ${distanceFormat.format(metres / 1_000)} 公里`;
    if (pairDistance.textContent !== label) pairDistance.textContent = label;
    const recentlyNearby = isNearby;
    const accuracy = deviceFix?.accuracy;
    const fresh = Date.now() - Math.min(deviceFix?.capturedAt ?? 0, peer.updatedAt ?? 0) < pairFreshness;
    pairStale.hidden = fresh;
    isNearby = fresh && !(accuracy > 75) && metres <= (recentlyNearby ? leaveNearbyDistance : nearbyDistance);
    nearby.hidden = !isNearby && !hasMet;
    if (isNearby && !recentlyNearby && !hasMet) pairAnnouncement.textContent = '你們已靠近。你們目前在做什麼？';
    if (!isNearby) pairAnnouncement.textContent = '';
  }

  function draw() {
    frame = 0;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;
    const left = center.x - width / 2;
    const top = center.y - height / 2;
    const maximumTile = 2 ** zoom - 1;
    const visibleKeys = new Set();
    for (let y = Math.max(0, Math.floor(top / tileSize)); y <= Math.min(maximumTile, Math.ceil((top + height) / tileSize) - 1); y++) {
      for (let x = Math.max(0, Math.floor(left / tileSize)); x <= Math.min(maximumTile, Math.ceil((left + width) / tileSize) - 1); x++) {
        const key = `${zoom}/${x}/${y}`;
        visibleKeys.add(key);
        const tile = tileEntries.get(key) ?? createTile(x, y);
        tileEntries.set(key, tile);
        tile.image.style.left = `${Math.round(x * tileSize - left)}px`;
        tile.image.style.top = `${Math.round(y * tileSize - top)}px`;
      }
    }
    for (const [key, tile] of tileEntries) {
      if (visibleKeys.has(key)) continue;
      tile.image.remove();
      tileEntries.delete(key);
    }
    const catalog = new Map();
    if (placeKindFilter !== 'library') {
      ensureCafeCatalog(viewCafeBounds(zoom, left, top, width, height));
      for (const [id, cafe] of activeCafes) catalog.set(id, cafe);
      if (sharedCafe) catalog.set(sharedCafe.id, sharedCafe);
      if (selectedCafe) catalog.set(selectedCafe.id, selectedCafe);
    }
    const { members, clusters, groupedIds } = visibleCafes(catalog, zoom, left, top, width, height, [sharedCafe?.id, selectedCafe?.id]);
    drawCafeMarkers(members, groupedIds);
    drawCafeList(members);
    positionPins([...visiblePins, ...cafePins.values()], zoom, left, top, width, height);
    drawClusters(clusters, left, top);
    positionSpecialPin(meetingPin, meeting?.position, left, top, width, height);
    positionSpecialPin(peerPin, peer?.expiresAt > Date.now() ? peer.position : null, left, top, width, height);
    positionSpecialPin(locationPin, location, left, top, width, height);
    drawRoute(left, top, width, height);
    drawLivePair(left, top);
    zoomIn.setAttribute('aria-disabled', String(zoom === maxZoom));
    zoomOut.setAttribute('aria-disabled', String(zoom === minZoom));
    updateTileStatus();
  }

  function scheduleDraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  map.addEventListener('click', event => {
    const filter = event.target.closest('[data-map-place-filter]');
    if (filter) filterPlaces(filter);
    const place = event.target.closest('[data-map-place]');
    if (place) selectPlace(place);
    const commandButton = event.target.closest('[data-map-command]');
    const command = commandButton?.dataset.mapCommand;
    if (command === 'zoom-in') changeZoom(1);
    if (command === 'zoom-out') changeZoom(-1);
    if (command === 'reset') {
      closePlace();
      resetView();
    }
    if (command === 'close-place') closePlace(true);
    if (command === 'locate') locateDevice();
    if (command === 'stop-locate') {
      stopLocating('已停止顯示我的位置。');
      notifyLocation('-stopped', { reason: 'user' });
      viewport.querySelector('[data-map-command="locate"]').focus({ preventScroll: true });
    }
    if (command === 'fit-pair') {
      const points = pairPoints();
      if (points.length) fitPoints(points);
    }
    if (command === 'pair-met') {
      hasMet = true;
      nearbyTitle.textContent = '已碰面';
      nearbyNote.textContent = '可以一起選一間咖啡廳，或開始共讀。';
      metButton.hidden = true;
      nearbyTitle.focus({ preventScroll: true });
    }
    if (command === 'clear-route') {
      clearRoute();
      viewport.focus({ preventScroll: true });
    }
    if (command === 'rendezvous' && meeting) showPlaceDetail(meetingPin, 'rendezvous', meeting.name, meeting.position);
    if (command === 'peer-location' && peer?.expiresAt > Date.now()) showPlaceDetail(peerPin, 'peer', '配對對象分享的位置', peer.position);
    if (command === 'taiwan-overview') taiwanOverview();
    if (command === 'more-cafes') {
      cafeLimit += cafePageSize;
      scheduleDraw();
    }
    if (command === 'cafe-cluster' && zoom < maxZoom) {
      zoom += 1;
      setCenter(Number(commandButton.dataset.worldX) * 2, Number(commandButton.dataset.worldY) * 2);
    }
  }, options);

  map.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !detail || detail.hidden) return;
    closePlace(detail.contains(document.activeElement));
    event.preventDefault();
  }, options);

  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport || event.altKey || event.ctrlKey || event.metaKey) return;
    const arrows = { ArrowUp: [0, -85], ArrowDown: [0, 85], ArrowLeft: [-85, 0], ArrowRight: [85, 0] };
    const offset = arrows[event.key];
    if (offset) {
      setCenter(center.x + offset[0], center.y + offset[1]);
    } else if (event.key === '+' || event.key === '=') {
      changeZoom(1);
    } else if (event.key === '-') {
      changeZoom(-1);
    } else {
      return;
    }
    event.preventDefault();
  }, options);

  viewport.addEventListener('wheel', event => {
    if (!event.cancelable || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (event.altKey || event.metaKey || event.shiftKey || (event.ctrlKey && !viewport.matches(':focus-within'))) return;
    const step = -Math.sign(event.deltaY);
    if ((step > 0 && zoom === maxZoom) || (step < 0 && zoom === minZoom)) {
      wheelDelta = 0;
      return;
    }
    event.preventDefault();
    if (event.timeStamp - lastWheelAt > 220 || Math.sign(wheelDelta) !== Math.sign(event.deltaY)) wheelDelta = 0;
    lastWheelAt = event.timeStamp;
    wheelDelta += event.deltaMode ? Math.sign(event.deltaY) * 80 : event.deltaY;
    if (Math.abs(wheelDelta) < 48) return;
    changeZoom(step, viewportPoint(event.clientX, event.clientY));
    wheelDelta = 0;
  }, { ...options, passive: false });

  function pinchGeometry() {
    const [first, second] = pointers.values();
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
      distance: Math.hypot(first.x - second.x, first.y - second.y),
    };
  }

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button, a, [data-map-place-detail]')) return;
    if (pointers.size >= 2 || (pointers.size && event.pointerType !== 'touch')) return;
    pointers.set(event.pointerId, viewportPoint(event.clientX, event.clientY));
    if (pointers.size === 2) pinchDistance = pinchGeometry().distance;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('campus-map-dragging');
  }, options);

  viewport.addEventListener('pointermove', event => {
    const before = pointers.get(event.pointerId);
    if (!before) return;
    const after = viewportPoint(event.clientX, event.clientY);
    pointers.set(event.pointerId, after);
    if (pointers.size === 1) {
      setCenter(center.x + before.x - after.x, center.y + before.y - after.y);
      return;
    }
    const pinch = pinchGeometry();
    setCenter(center.x + (before.x - after.x) / 2, center.y + (before.y - after.y) / 2);
    const factor = 1.5;
    if (!pinchDistance) pinchDistance = pinch.distance;
    if (pinch.distance > pinchDistance * factor || pinch.distance < pinchDistance / factor) {
      changeZoom(pinch.distance > pinchDistance ? 1 : -1, pinch);
      pinchDistance = pinch.distance;
    }
  }, options);

  viewport.addEventListener('lostpointercapture', event => {
    if (!pointers.delete(event.pointerId)) return;
    pinchDistance = 0;
    if (!pointers.size) viewport.classList.remove('campus-map-dragging');
  }, options);

  const observer = new ResizeObserver(() => {
    if (!pairFitted && pairPoints().length) refreshPairView();
    else if (atCampusOverview) resetView();
    else scheduleDraw();
  });
  mapControllers.set(map, { viewDestination, showRoute, clearRoute, locateDevice });
  observer.observe(viewport);
  draw();
  return () => {
    mapControllers.delete(map);
    routeRequest?.abort();
    cafeRequest?.abort();
    clearTimeout(cafeTimer);
    clearTimeout(peerExpiry);
    clearTimeout(ownExpiry);
    clearTimeout(freshnessTimer);
    stopLocating();
    observer.disconnect();
    events.abort();
    cancelAnimationFrame(frame);
  };
}
