/**
 * Original line icons for Luxury Tech graphics (24×24 grid, round caps/joins).
 * Stroke colour comes from `currentColor`; fills use `currentColor` where marked.
 */
const ICONS: Record<string, string> = {
  car: `<path d="M3.5 15.5v-3.2c0-.6.3-1.1.8-1.4l2.4-1.5 1.9-3c.4-.6 1-.9 1.7-.9h4.1c.7 0 1.3.3 1.7.9l1.9 3 1.9.6c.9.3 1.5 1.1 1.5 2.1v3.4"/><path d="M3.5 15.5h2.2M10 15.5h4.1M18.4 15.5h2.1"/><circle cx="7.9" cy="15.7" r="2.1"/><circle cx="16.2" cy="15.7" r="2.1"/><path d="M8.6 9.4h7.3"/>`,
  plane: `<path d="M12 2.8c.8 0 1.3.8 1.3 1.8v5l7.2 4.3v1.9l-7.2-2.2v4.3l2.3 1.8v1.5L12 20.3l-3.6 1v-1.5l2.3-1.8v-4.3l-7.2 2.2V14l7.2-4.3v-5c0-1 .5-1.9 1.3-1.9z"/>`,
  radar: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 12l6.2-6.2"/>`,
  moon: `<circle cx="12" cy="12" r="8.6"/><circle cx="9" cy="9.2" r="1.7"/><circle cx="14.8" cy="14.4" r="2.3"/><circle cx="14.6" cy="7.6" r=".9"/><circle cx="8.3" cy="15" r="1"/>`,
  rocket: `<path d="M12 2.6c3 2.2 4.6 5.6 4.6 9.4v4.2H7.4V12c0-3.8 1.6-7.2 4.6-9.4z"/><circle cx="12" cy="9.6" r="1.8"/><path d="M7.4 13.2l-2.6 2.4v3l2.6-1.2M16.6 13.2l2.6 2.4v3l-2.6-1.2M10.2 16.2v2.4M13.8 16.2v2.4M12 16.2v4.6"/>`,
  globe: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9M12 3C9.4 5.6 8.1 8.6 8.1 12s1.3 6.4 3.9 9"/>`,
  chip: `<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx=".8"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>`,
  sparkle: `<path d="M12 3.2l1.9 5.4 5.4 1.9-5.4 1.9L12 17.8l-1.9-5.4-5.4-1.9 5.4-1.9z"/><path d="M18.6 15.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>`,
  steering: `<circle cx="12" cy="12" r="8.8"/><circle cx="12" cy="12" r="2.4"/><path d="M3.6 10.4c2.6-.9 5.4-1.3 8.4-1.3s5.8.4 8.4 1.3M10.2 14l-3.8 6M13.8 14l3.8 6"/>`,
  lander: `<path d="M8.2 6.2h7.6l1.6 5.6H6.6z"/><path d="M12 3v3.2M6.6 11.8l-3 6.2M17.4 11.8l3 6.2M9.4 11.8l-1.2 6.2M14.6 11.8l1.2 6.2M2.4 18h3.2M18.4 18h3.2M6.8 18h2.6M14.6 18h2.6"/>`,
  satellite: `<rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1" transform="rotate(45 12 12)"/><path d="M5.2 5.2l3.4 3.4M15.4 15.4l3.4 3.4"/><rect x="1.8" y="3.6" width="6" height="3" rx=".6" transform="rotate(45 4.8 5.1)"/><rect x="16.2" y="17.4" width="6" height="3" rx=".6" transform="rotate(45 19.2 18.9)"/><path d="M15.6 6.2a3 3 0 0 1 2.2 2.2M16.2 3.6a5.6 5.6 0 0 1 4.2 4.2"/>`,
  person: `<circle cx="12" cy="8.6" r="3.6"/><path d="M4.8 20c.8-3.9 3.6-6.2 7.2-6.2s6.4 2.3 7.2 6.2"/>`,
  people: `<circle cx="8.6" cy="8.4" r="3"/><path d="M3.2 19.2c.5-3.2 2.7-5.2 5.4-5.2s4.9 2 5.4 5.2"/><circle cx="16.4" cy="9.4" r="2.5"/><path d="M15 14.4c2.7-.3 5 1.4 5.7 4.8"/>`,
  arrow: `<path d="M4 12h15M13.5 6.5L19 12l-5.5 5.5"/>`,
  send: `<path d="M12 19V5.6M6.2 11.4L12 5.6l5.8 5.8"/>`,
  check: `<path d="M5.2 12.6l4.3 4.2 9.3-9.6"/>`,
  cross: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  bolt: `<path d="M13.4 2.8L5.6 13.4h6l-1 7.8 7.8-10.6h-6z"/>`,
  shield: `<path d="M12 3l7.2 2.8v5.6c0 4.4-3 8.1-7.2 9.6-4.2-1.5-7.2-5.2-7.2-9.6V5.8z"/><path d="M8.8 12.2l2.2 2.2 4.4-4.6"/>`,
};

export function iconNames(): string[] {
  return Object.keys(ICONS);
}

/** Inline SVG for an icon; throws for unknown names so specs fail loudly. */
export function iconSvg(name: string, sizePx: number, strokeWidth = 1.6): string {
  const body = ICONS[name];
  if (!body) throw new Error(`unknown icon "${name}" (available: ${iconNames().join(", ")})`);
  return `<svg class="ico" width="${sizePx}" height="${sizePx}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
