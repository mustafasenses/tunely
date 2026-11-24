// Inline SVG icons (stroke-based, 24×24, currentColor). Decorative: aria-hidden.
const svg = (body: string, extra = ''): string =>
  `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

export const icons = {
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>'),
  micOff: svg(
    '<path d="M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M19 11a7 7 0 0 1-1.1 3.8M5 11a7 7 0 0 0 11 5.7"/><path d="M12 18v3"/><path d="m3 3 18 18"/>',
  ),
  settings: svg(
    '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  ),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.3"/><path d="M12 17h.01"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  speaker: svg(
    '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  ),
  pause: svg('<path d="M9 6v12M15 6v12"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5z"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  ear: svg('<path d="M7 9a5 5 0 0 1 10 0c0 3-3 4-3 7a3 3 0 0 1-5.5 1.6"/><path d="M10 9.5a2 2 0 0 1 4 0"/>'),
  alert: svg('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 17h.01"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
} as const;

/** Brand mark (same artwork as the app icon, simplified). */
export const logoMark = `<svg class="logo-mark" viewBox="0 0 64 64" width="32" height="32" aria-hidden="true" focusable="false">
  <path d="M14.3 30.6A20 20 0 0 1 49.7 30.6" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="5" stroke-linecap="round"/>
  <path d="M28.9 20.3A20 20 0 0 1 35.1 20.3" fill="none" stroke="var(--c-in)" stroke-width="5"/>
  <path d="M32 41 32 24.5" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/>
  <circle cx="32" cy="41" r="4.6" fill="currentColor"/>
</svg>`;
