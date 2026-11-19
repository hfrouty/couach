const paths = {
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.7 8.3-2.1 5.3-5.3 2.1 2.1-5.3 5.3-2.1Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18m-12 5h2m3 0h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6m3 4 2-2"/>',
  pin: '<path d="M19 10c0 5-7 10-7 10s-7-5-7-10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  sliders: '<path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 4.1a4 4 0 0 1 0 7.8"/><circle cx="9" cy="8" r="4"/>',
  laptop: '<rect x="5" y="4" width="14" height="12" rx="2"/><path d="m5 16-3 4h20l-3-4"/>',
  shield: '<path d="M12 22s7-3 7-10V5l-7-3-7 3v7c0 7 7 10 7 10Z"/><path d="m9 12 2 2 4-4"/>',
  spark: '<path d="M12 2c.6 6 3.4 8.8 9 10-5.6 1.2-8.4 4-9 10-.6-6-3.4-8.8-9-10 5.6-1.2 8.4-4 9-10Z"/>',
  book: '<path d="M12 7c-3-2.5-6.3-2.7-10-1.5V18c3.7-1.2 7-1 10 1.5 3-2.5 6.3-2.7 10-1.5V5.5c-3.7-1.2-7-1-10 1.5v12.5"/>',
  map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  pause: '<path d="M9 5v14m6-14v14"/>',
  rotate: '<path d="M4 11a8 8 0 1 1 2 6m-2-6V5m0 6h6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cup: '<path d="M4 8h13v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Zm13 1h2a2 2 0 0 1 0 4h-2M3 22h17M8 5V2m5 3V2"/>',
  library: '<path d="m3 8 9-5 9 5m-17 2h16M6 10v8m6-8v8m6-8v8M3 21h18M4 18h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  flag: '<path d="M5 21V4m0 0c5-4 9 4 14 0v10c-5 4-9-4-14 0"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
};

export function icon(name) {
  return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ''}</svg>`;
}
