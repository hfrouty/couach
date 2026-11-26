import { icon } from './icons.mjs';
import { DEFAULT_CAMPUS_ID, getCampus } from './campuses.mjs';

const tileSize = 256;
const minZoom = 13;
const maxZoom = 18;
const minLatitude = -85.05112878;
const maxLatitude = 85.05112878;
const tileSource = 'https://tile.openstreetmap.org';
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

function availablePlaces(places) {
  return places.filter(({ kind, position }) => {
    if (!Object.hasOwn(placeKinds, kind) || !Array.isArray(position) || position.length !== 2) return false;
    const [latitude, longitude] = position;
    return Number.isFinite(latitude) && latitude >= minLatitude && latitude <= maxLatitude
      && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  });
}

function directionsURL(latitude, longitude) {
  const url = new URL('https://www.google.com/maps/dir/');
  url.search = new URLSearchParams({ api: '1', destination: `${latitude},${longitude}`, travelmode: 'walking' });
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
  const kinds = Object.keys(placeKinds).filter(kind => places.some(place => place.kind === kind));
  return `<div class="campus-map-place-filters" role="group" aria-label="篩選地圖地點">
    <button type="button" class="campus-map-place-filter" data-map-place-filter="" aria-pressed="true">全部地點</button>
    ${kinds.map(kind => `<button type="button" class="campus-map-place-filter campus-map-place-kind"
      data-map-place-filter="${kind}" data-place-kind="${kind}" aria-pressed="false">${icon(placeKinds[kind].glyph)} ${placeKinds[kind].label}</button>`).join('')}
  </div>`;
}

function placeList(places) {
  return `<section class="campus-map-places" aria-labelledby="campus-map-places-title">
    <h2 id="campus-map-places-title">周邊地點</h2>
    <div class="campus-map-place-groups">
      ${Object.entries(placeKinds).map(([kind, { label, glyph }]) => {
        const members = places.filter(place => place.kind === kind);
        if (!members.length) return '';
        return `<div class="campus-map-place-group" data-map-place-group="${kind}">
          <h3><span class="campus-map-legend-icon campus-map-place-kind" data-place-kind="${kind}">${icon(glyph)}</span>${label}</h3>
          <ul>${members.map(({ id, name, position }) => `<li>
            <button type="button" data-map-place="${escape(id)}" aria-pressed="false">${escape(name)}</button>
            <a href="${escape(directionsURL(...position))}" target="_blank" rel="noopener noreferrer"
              aria-label="${escape(name)}的 Google 地圖步行路線">路線</a>
          </li>`).join('')}</ul>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

export function renderCampusMap({
  selectedRegion = '', invitations = [], campus = DEFAULT_MAP_CAMPUS, actions = '', places = [],
} = {}) {
  const [latitude, longitude] = campus.center;
  const counts = invitationCounts(invitations);
  const name = escape(campus.name);
  const landmarks = availablePlaces(places);
  return `<section class="campus-map" aria-labelledby="campus-map-title" data-campus-map>
    <header class="campus-map-header">
      <div>
        <p class="campus-map-school">${icon('pin')} ${name}${campus.area ? ` · ${escape(campus.area)}` : ''}</p>
        <h2 id="campus-map-title">校園共讀地圖</h2>
        <p class="campus-map-instructions">點選共讀區域查看邀約${landmarks.length ? '，也可以查找圖書館與咖啡廳。' : '。'}</p>
      </div>
      ${actions ? `<div class="campus-map-actions">${actions}</div>` : ''}
    </header>
    ${landmarks.length ? placeFilters(landmarks) : ''}
    <div class="campus-map-content${landmarks.length ? ' campus-map-content-with-places' : ''}">
      <div class="campus-map-surface">
        <div class="campus-map-viewport" data-map-viewport data-latitude="${Number(latitude)}" data-longitude="${Number(longitude)}"
          data-zoom="${Number(campus.zoom ?? 16)}" tabindex="0" role="group" aria-label="${name}周邊地圖"
          aria-describedby="campus-map-keyboard">
          <span class="sr-only" id="campus-map-keyboard">可用滑鼠滾輪縮放，或用方向鍵移動地圖、按加號或減號縮放。按 Tab 使用地圖控制或下方清單。</span>
          <div class="campus-map-tiles" data-map-tiles aria-hidden="true"></div>
          <div class="campus-map-pins">
            ${campus.regions.map(region => regionButton(region, selectedRegion, counts.get(region.name) ?? 0, true)).join('')}
            ${landmarks.map(placeMarker).join('')}
          </div>
          <div class="campus-map-controls" role="group" aria-label="地圖控制">
            <div class="campus-map-zoom-controls">
              <button type="button" data-map-command="zoom-in" aria-label="放大地圖" title="放大地圖">+</button>
              <button type="button" data-map-command="zoom-out" aria-label="縮小地圖" title="縮小地圖">−</button>
            </div>
            <button type="button" data-map-command="reset" aria-label="回到校園中心" title="回到校園中心">${icon('compass')}</button>
          </div>
          ${landmarks.length ? `<div class="campus-map-place-detail campus-map-place-kind" data-map-place-detail hidden>
            <span class="campus-map-legend-icon" data-map-detail-icon></span>
            <div>
              <strong data-map-detail-name></strong>
              <a data-map-detail-directions target="_blank" rel="noopener noreferrer">Google 地圖路線</a>
            </div>
            <button type="button" data-map-command="close-place" aria-label="關閉地點資訊">${icon('close')}</button>
          </div>` : ''}
          <p class="campus-map-error" data-map-error role="status" hidden>目前無法載入底圖，仍可使用標記與下方清單。</p>
          <div class="campus-map-attribution">
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>
          </div>
        </div>
        <div class="campus-map-footer">
          <p class="campus-map-wheel-hint">在地圖上滾動滑鼠滾輪可縮放</p>
          <ul class="campus-map-legend" aria-label="地圖圖例">
            <li><span class="campus-map-legend-icon">${icon('pin')}</span>共讀區域</li>
            ${Object.entries(placeKinds).filter(([kind]) => landmarks.some(place => place.kind === kind)).map(([kind, { label, glyph }]) =>
              `<li data-map-place-legend="${kind}"><span class="campus-map-legend-icon campus-map-place-kind" data-place-kind="${kind}">${icon(glyph)}</span>${label}</li>`).join('')}
          </ul>
          <div class="campus-region-list" role="group" aria-label="依校園區域篩選">
            <button type="button" class="campus-region-button" data-action="map-region" data-value=""
              aria-pressed="${!selectedRegion}">所有區域</button>
            ${campus.regions.map(region => regionButton(region, selectedRegion, counts.get(region.name) ?? 0)).join('')}
          </div>
        </div>
      </div>
      ${landmarks.length ? placeList(landmarks) : ''}
    </div>
  </section>`;
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
    const crowded = width < 440 || visible.some(other => other !== pin
      && Math.abs(pin.x - other.x) < 100 && Math.abs(pin.y - other.y) < 60);
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
  const error = viewport.querySelector('[data-map-error]');
  const pins = [...viewport.querySelectorAll('[data-map-pin]')];
  const map = viewport.closest('[data-campus-map]');
  const placeButtons = [...map.querySelectorAll('[data-map-place]')];
  const placePins = new Map(pins.filter(pin => pin.hasAttribute('data-map-place')).map(pin => [pin.dataset.mapPlace, pin]));
  const filterButtons = [...map.querySelectorAll('[data-map-place-filter]')];
  const placeGroups = [...map.querySelectorAll('[data-map-place-group]')];
  const placeLegends = [...map.querySelectorAll('[data-map-place-legend]')];
  const detail = viewport.querySelector('[data-map-place-detail]');
  const detailIcon = detail?.querySelector('[data-map-detail-icon]');
  const detailName = detail?.querySelector('[data-map-detail-name]');
  const detailDirections = detail?.querySelector('[data-map-detail-directions]');
  const zoomIn = viewport.querySelector('[data-map-command="zoom-in"]');
  const zoomOut = viewport.querySelector('[data-map-command="zoom-out"]');
  const coordinates = [Number(viewport.dataset.latitude), Number(viewport.dataset.longitude)];
  const defaultZoom = clamp(Number(viewport.dataset.zoom), minZoom, maxZoom);
  const tileEntries = new Map();
  const pointers = new Map();
  const events = new AbortController();
  const options = { signal: events.signal };
  let visiblePins = pins;
  let zoom = fitZoom();
  let center = worldPoint(...coordinates, zoom);
  let frame = 0;
  let atCampusOverview = true;
  let selectedPlaceTrigger;
  let pinchDistance = 0;
  let lastWheelAt = 0;
  let wheelDelta = 0;

  function fitZoom() {
    const halfWidth = Math.max(0, viewport.clientWidth / 2 - 55);
    const halfHeight = Math.max(0, viewport.clientHeight / 2 - 50);
    if (!placePins.size || !halfWidth || !halfHeight) return defaultZoom;
    for (let level = defaultZoom; level > minZoom; level -= 1) {
      const midpoint = worldPoint(...coordinates, level);
      const fits = visiblePins.every(pin => {
        const position = worldPoint(Number(pin.dataset.latitude), Number(pin.dataset.longitude), level);
        return Math.abs(position.x - midpoint.x) <= halfWidth && Math.abs(position.y - midpoint.y) <= halfHeight;
      });
      if (fits) return level;
    }
    return minZoom;
  }

  function setCenter(x, y) {
    const [latitude, longitude] = coordinates;
    const topLeft = worldPoint(latitude + .03, longitude - .035, zoom);
    const bottomRight = worldPoint(latitude - .03, longitude + .035, zoom);
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
    const pin = placePins.get(placeId);
    const { latitude, longitude, placeName, placeKind } = pin.dataset;
    selectedPlaceTrigger = button;
    for (const item of placeButtons) item.setAttribute('aria-pressed', String(item.dataset.mapPlace === placeId));
    detail.dataset.placeKind = placeKind;
    detailIcon.innerHTML = icon(placeKinds[placeKind].glyph);
    detailName.textContent = placeName;
    detailDirections.href = directionsURL(latitude, longitude);
    detailDirections.setAttribute('aria-label', `${placeName}的 Google 地圖步行路線`);
    detail.hidden = false;
    const position = worldPoint(Number(latitude), Number(longitude), zoom);
    setCenter(position.x, position.y);
  }

  function closePlace(restoreFocus = false) {
    if (!detail || detail.hidden) return;
    detail.hidden = true;
    for (const button of placeButtons) button.setAttribute('aria-pressed', 'false');
    if (restoreFocus) (selectedPlaceTrigger?.hidden ? viewport : selectedPlaceTrigger)?.focus({ preventScroll: true });
    selectedPlaceTrigger = undefined;
  }

  function filterPlaces(filter) {
    if (filter.getAttribute('aria-pressed') === 'true') return;
    const kind = filter.dataset.mapPlaceFilter;
    closePlace();
    visiblePins = pins.filter(pin => {
      const keep = !kind || !pin.dataset.placeKind || pin.dataset.placeKind === kind;
      if (!keep) pin.hidden = true;
      return keep;
    });
    for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.mapPlaceFilter === kind));
    for (const group of placeGroups) group.hidden = Boolean(kind && group.dataset.mapPlaceGroup !== kind);
    for (const legend of placeLegends) legend.hidden = Boolean(kind && legend.dataset.mapPlaceLegend !== kind);
    resetView();
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
    positionPins(visiblePins, zoom, left, top, width, height);
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
    const command = event.target.closest('[data-map-command]')?.dataset.mapCommand;
    if (command === 'zoom-in') changeZoom(1);
    if (command === 'zoom-out') changeZoom(-1);
    if (command === 'reset') {
      closePlace();
      resetView();
    }
    if (command === 'close-place') closePlace(true);
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
    if (atCampusOverview) resetView();
    else scheduleDraw();
  });
  observer.observe(viewport);
  draw();
  return () => {
    observer.disconnect();
    events.abort();
    cancelAnimationFrame(frame);
  };
}
