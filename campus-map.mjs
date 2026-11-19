import { icon } from './icons.mjs';

const tileSize = 256;
const minZoom = 13;
const maxZoom = 18;
const minLatitude = -85.05112878;
const maxLatitude = 85.05112878;
const tileSource = 'https://tile.openstreetmap.org';

export const DEFAULT_MAP_CAMPUS = {
  name: '國立暨南國際大學',
  center: [23.95165, 120.92715],
  zoom: 16,
  regions: [
    { name: '圖書館周邊', label: '圖書館', position: [23.9517, 120.9262] },
    { name: '人文學院周邊', label: '人文學院', position: [23.9501, 120.9292] },
    { name: '科技學院周邊', label: '科技學院', position: [23.9545, 120.9277] },
    { name: '管理學院周邊', label: '管理學院', position: [23.9521, 120.9278] },
    { name: '學生宿舍周邊', label: '學生宿舍', position: [23.9489, 120.9252] },
  ],
};

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
      <span>${label}</span>${count ? `<span class="campus-map-pin-count">${count}</span>` : ''}
    </button>`;
  }
  return `<button ${attrs} class="campus-region-button" aria-label="${name}，${count} 個邀約">
    ${name}${count ? `<span class="campus-region-count" aria-hidden="true">${count}</span>` : ''}
  </button>`;
}

export function renderCampusMap({
  selectedRegion = '', invitations = [], campus = DEFAULT_MAP_CAMPUS, actions = '',
} = {}) {
  const [latitude, longitude] = campus.center;
  const counts = invitationCounts(invitations);
  const name = escape(campus.name);
  return `<section class="campus-map" aria-labelledby="campus-map-title" data-campus-map>
    <header class="campus-map-header">
      <div>
        <p class="campus-map-school">${icon('pin')} ${name}</p>
        <h1 id="campus-map-title">校園共讀地圖</h1>
        <p class="campus-map-instructions">點選區域標記，查看附近的共讀邀約。</p>
      </div>
      ${actions ? `<div class="campus-map-actions">${actions}</div>` : ''}
    </header>
    <div class="campus-map-viewport" data-map-viewport data-latitude="${Number(latitude)}" data-longitude="${Number(longitude)}"
      data-zoom="${Number(campus.zoom ?? 16)}" tabindex="0" role="group" aria-label="${name}周邊地圖"
      aria-describedby="campus-map-keyboard">
      <span class="sr-only" id="campus-map-keyboard">可用方向鍵移動地圖、加號與減號縮放，或使用下方的區域按鈕。</span>
      <div class="campus-map-tiles" data-map-tiles aria-hidden="true"></div>
      <div class="campus-map-pins">
        ${campus.regions.map(region => regionButton(region, selectedRegion, counts.get(region.name) ?? 0, true)).join('')}
      </div>
      <div class="campus-map-controls" role="group" aria-label="地圖控制">
        <button type="button" data-map-command="zoom-in" aria-label="放大地圖" title="放大地圖">＋</button>
        <button type="button" data-map-command="zoom-out" aria-label="縮小地圖" title="縮小地圖">−</button>
        <button type="button" data-map-command="reset" aria-label="回到校園中心" title="回到校園中心">${icon('compass')}</button>
      </div>
      <p class="campus-map-error" data-map-error hidden>目前無法載入底圖，仍可選擇區域。</p>
      <div class="campus-map-attribution">
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>
      </div>
    </div>
    <div class="campus-map-footer">
      <div class="campus-region-list" role="group" aria-label="依校園區域篩選">
        <button type="button" class="campus-region-button" data-action="map-region" data-value=""
          aria-pressed="${!selectedRegion}">所有區域</button>
        ${campus.regions.map(region => regionButton(region, selectedRegion, counts.get(region.name) ?? 0)).join('')}
      </div>
      <p class="campus-map-note">${icon('shield')} 標記代表校園公共區域。</p>
    </div>
  </section>`;
}

export function updateCampusMapSelection(root, selectedRegion = '') {
  for (const button of root.querySelectorAll('[data-campus-map] [data-action="map-region"]')) {
    button.setAttribute('aria-pressed', String(button.dataset.value === selectedRegion));
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

export function bindCampusMap(root) {
  const viewport = root.querySelector('[data-map-viewport]');
  if (!viewport) return () => {};

  const tiles = viewport.querySelector('[data-map-tiles]');
  const error = viewport.querySelector('[data-map-error]');
  const pins = [...viewport.querySelectorAll('[data-map-pin]')];
  const zoomIn = viewport.querySelector('[data-map-command="zoom-in"]');
  const zoomOut = viewport.querySelector('[data-map-command="zoom-out"]');
  const coordinates = [Number(viewport.dataset.latitude), Number(viewport.dataset.longitude)];
  const defaultZoom = clamp(Number(viewport.dataset.zoom), minZoom, maxZoom);
  const tileEntries = new Map();
  const events = new AbortController();
  const options = { signal: events.signal };
  let zoom = defaultZoom;
  let center = worldPoint(...coordinates, zoom);
  let frame = 0;
  let drag;

  function setCenter(x, y) {
    const [latitude, longitude] = coordinates;
    const topLeft = worldPoint(latitude + .03, longitude - .035, zoom);
    const bottomRight = worldPoint(latitude - .03, longitude + .035, zoom);
    center = { x: clamp(x, topLeft.x, bottomRight.x), y: clamp(y, topLeft.y, bottomRight.y) };
    scheduleDraw();
  }

  function changeZoom(offset) {
    const next = clamp(zoom + offset, minZoom, maxZoom);
    if (next === zoom) return;
    const scale = 2 ** (next - zoom);
    zoom = next;
    setCenter(center.x * scale, center.y * scale);
  }

  function resetView() {
    zoom = defaultZoom;
    center = worldPoint(...coordinates, zoom);
    scheduleDraw();
  }

  function updateTileStatus() {
    error.hidden = !tileEntries.size || ![...tileEntries.values()].every(tile => tile.failed);
  }

  function createTile(tileX, tileY) {
    const image = document.createElement('img');
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    // Preserve only the site origin in tile requests, as required by OpenStreetMap.
    image.referrerPolicy = 'origin';
    const tile = { image, failed: false };
    image.addEventListener('error', () => {
      tile.failed = true;
      image.hidden = true;
      updateTileStatus();
    }, options);
    image.src = `${tileSource}/${zoom}/${tileX}/${tileY}.png`;
    tiles.append(image);
    return tile;
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
    for (const pin of pins) {
      const position = worldPoint(Number(pin.dataset.latitude), Number(pin.dataset.longitude), zoom);
      const x = position.x - left;
      const y = position.y - top;
      pin.hidden = x < 0 || y < 0 || x > width || y > height;
      pin.style.left = `${x}px`;
      pin.style.top = `${y}px`;
    }
    zoomIn.setAttribute('aria-disabled', String(zoom === maxZoom));
    zoomOut.setAttribute('aria-disabled', String(zoom === minZoom));
    updateTileStatus();
  }

  function scheduleDraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  viewport.addEventListener('click', event => {
    const command = event.target.closest('[data-map-command]')?.dataset.mapCommand;
    if (command === 'zoom-in') changeZoom(1);
    if (command === 'zoom-out') changeZoom(-1);
    if (command === 'reset') resetView();
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

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || event.target.closest('button, a')) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, center };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('campus-map-dragging');
  }, options);

  viewport.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    setCenter(drag.center.x - (event.clientX - drag.x), drag.center.y - (event.clientY - drag.y));
  }, options);

  viewport.addEventListener('lostpointercapture', event => {
    if (drag?.id !== event.pointerId) return;
    drag = undefined;
    viewport.classList.remove('campus-map-dragging');
  }, options);

  const observer = new ResizeObserver(scheduleDraw);
  observer.observe(viewport);
  draw();
  return () => {
    observer.disconnect();
    events.abort();
    cancelAnimationFrame(frame);
  };
}
