import { DEFAULT_CAMPUS_ID, getCampus } from './campuses.mjs';

const relatedSubjects = [
  ["微積分", "統計學", "經濟學"],
  ["英文", "日文"],
];

function timeValue(value) {
  return value == null || value === "" ? Number.NaN : new Date(value).getTime();
}

function timeOverlap(session, preferences) {
  const requestedStart = timeValue(preferences.start);
  const requestedEnd = timeValue(preferences.end);
  if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd)) return 1;
  if (requestedEnd <= requestedStart) return 0;

  const overlapStart = Math.max(timeValue(session.start), requestedStart);
  const overlapEnd = Math.min(timeValue(session.end), requestedEnd);
  const overlap = overlapEnd - overlapStart;
  return overlap > 0 ? overlap / (requestedEnd - requestedStart) : 0;
}

// Estimate the straight-line distance between public area markers in meters.
export function markerDistance(first, second) {
  const latitude = (first[0] + second[0]) * Math.PI / 360;
  const north = (first[0] - second[0]) * 111_320;
  const east = (first[1] - second[1]) * 111_320 * Math.cos(latitude);
  return Math.hypot(north, east);
}

function distanceBetween(session, preferredRegion) {
  if (session.mode === "online" || !preferredRegion) return null;

  const campus = getCampus(session.campusId ?? DEFAULT_CAMPUS_ID);
  const preferred = campus?.regions.find(region => region.name === preferredRegion)?.position;
  const actual = campus?.regions.find(region => region.name === session.region)?.position;
  return preferred && actual ? Math.round(markerDistance(preferred, actual) / 50) * 50 : null;
}

function locationFit(session, preferredRegion, distance) {
  if (!preferredRegion) return 1;
  if (session.mode === "online") return 0.7;
  return distance === null ? 0 : Math.max(0, 1 - distance / 1_500);
}

function subjectFit(subject, preferredSubject) {
  if (!preferredSubject || subject === preferredSubject) return 1;

  const isRelated = relatedSubjects.some((group) => group.includes(subject) && group.includes(preferredSubject));
  return isRelated ? 0.5 : 0;
}

export function scoreSession(session, preferences = {}) {
  const distance = distanceBetween(session, preferences.region);
  const styleFit = !preferences.style || session.style === preferences.style ? 1 : 0;
  const score = 35 * timeOverlap(session, preferences)
    + 25 * locationFit(session, preferences.region, distance)
    + 20 * subjectFit(session.subject, preferences.subject)
    + 20 * styleFit;

  return { score: Math.round(score), distance };
}

export function isLive(session, now = new Date()) {
  const current = timeValue(now);
  return timeValue(session.start) <= current && current < timeValue(session.end);
}
