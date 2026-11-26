import { readFileSync } from 'node:fs';
import { CAMPUSES } from '../campuses.mjs';
import { getCampusPlaces } from '../campus-places.mjs';

const { cafes: rows } = JSON.parse(readFileSync(new URL('./taiwan-cafes.json', import.meta.url), 'utf8'));
const campusCafes = CAMPUSES.flatMap(campus => getCampusPlaces(campus.id)).filter(place => place.kind === 'cafe');
const cafes = [
  ...rows.map(([id, name, lat, lon]) => ({ id, name, kind: 'cafe', position: [lat, lon] })),
  ...campusCafes.filter(place => !place.id.startsWith('osm-')),
];
const cafesById = new Map([...campusCafes, ...cafes].map(place => [place.id, place]));

export function getCafeById(id) {
  return cafesById.get(id);
}

export function getCafesInBounds({ south, west, north, east }) {
  return cafes.filter(({ position: [latitude, longitude] }) => (
    latitude >= south && latitude <= north && longitude >= west && longitude <= east
  ));
}
