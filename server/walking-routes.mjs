import { setTimeout } from 'node:timers/promises';
import { getCampus } from '../campuses.mjs';
import { markerDistance } from '../matching.mjs';
import { getCafeById } from './taiwan-cafes.mjs';

const walkingService = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/';
const cacheLifetime = 30 * 60_000;
const cacheLimit = 400;
const requestInterval = 1_100;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function routeEndpoints({ campusId, fromRegion, toRegion, cafeId }) {
  const campus = getCampus(campusId);
  if (!campus) fail(400, '請選擇有效的校園。');
  const from = campus.regions.find(region => region.name === fromRegion)?.position;
  const to = cafeId === undefined
    ? campus.regions.find(region => region.name === toRegion)?.position
    : getCafeById(cafeId)?.position;
  if (!from || !to || (cafeId !== undefined && toRegion !== undefined)) {
    fail(400, '請選擇此校園的起點與步行目的地。');
  }
  if (markerDistance(from, to) > 20_000) fail(400, '目的地較遠，請開啟 Google 地圖查看可用的交通方式。');
  return { from, to };
}

async function fetchRoute(path, delay, fetchUpstream) {
  if (delay) await setTimeout(delay);
  const url = new URL(`${walkingService}${path}`);
  url.search = new URLSearchParams({ overview: 'full', geometries: 'geojson', generate_hints: 'false' });
  try {
    const response = await fetchUpstream(url, {
      headers: { 'User-Agent': 'StudyMate (https://github.com/hfrouty/couach)', Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 429) fail(429, '步行路線服務忙碌，請稍後再試。');
    if (!response.ok) fail(502, '目前無法取得步行路線。');
    const { routes, code } = await response.json();
    if (code === 'NoRoute') fail(404, '找不到可用的步行路線。');
    const route = routes?.[0];
    const geometry = route?.geometry?.coordinates;
    if (code !== 'Ok' || !Array.isArray(geometry) || geometry.length < 2 || geometry.length > 10_000
      || !geometry.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
      || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) {
      fail(502, '步行路線資料暫時無法使用。');
    }
    return {
      points: geometry.map(([longitude, latitude]) => [latitude, longitude]),
      distance: Math.round(route.distance), seconds: Math.round(route.duration),
    };
  } catch (error) {
    if (error.status) throw error;
    fail(502, '目前無法取得步行路線。');
  }
}

export function createWalkingRoutes(fetchUpstream = fetch) {
  const cache = new Map();
  let nextRequestAt = 0;
  return async (data) => {
    const { from, to } = routeEndpoints(data);
    const key = [from, to].map(([latitude, longitude]) => `${longitude},${latitude}`).join(';');
    if (from[0] === to[0] && from[1] === to[1]) return { points: [from, to], distance: 0, seconds: 0 };
    const now = Date.now();
    const existing = cache.get(key);
    if (existing && existing.expiresAt > now) return existing.pending;
    const delay = Math.max(0, nextRequestAt - now);
    if (delay > 2_500) fail(429, '步行路線服務忙碌，請稍後再試。');
    nextRequestAt = now + delay + requestInterval;
    if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
    const pending = fetchRoute(key, delay, fetchUpstream);
    cache.set(key, { expiresAt: now + cacheLifetime, pending });
    try {
      return await pending;
    } catch (error) {
      if (cache.get(key)?.pending === pending) cache.delete(key);
      throw error;
    }
  };
}
