// Persisted user settings (localStorage, failure-tolerant) + pure resolution helpers.
import { DEFAULT_A4, MAX_A4, MIN_A4, type NoteNaming } from '../music/notes';
import type { Lang } from '../i18n/strings';

export type LangSetting = 'auto' | Lang;
export type ThemeSetting = 'auto' | 'dark' | 'light';

export interface Settings {
  lang: LangSetting;
  /** null = follow the language default (TR → solfège, EN → letter). */
  naming: NoteNaming | null;
  a4: number;
  keepAwake: boolean;
  theme: ThemeSetting;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'auto',
  naming: null,
  a4: DEFAULT_A4,
  keepAwake: true,
  theme: 'auto',
};

const KEY = 'tunely.settings.v1';

export function clampA4(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_A4;
  return Math.min(MAX_A4, Math.max(MIN_A4, Math.round(v)));
}

/** Validate an untrusted parsed object into Settings. */
export function sanitizeSettings(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  if (r.lang === 'auto' || r.lang === 'en' || r.lang === 'tr') s.lang = r.lang;
  if (r.naming === 'letter' || r.naming === 'solfege' || r.naming === 'number') s.naming = r.naming;
  if (typeof r.a4 === 'number') s.a4 = clampA4(r.a4);
  if (typeof r.keepAwake === 'boolean') s.keepAwake = r.keepAwake;
  if (r.theme === 'auto' || r.theme === 'dark' || r.theme === 'light') s.theme = r.theme;
  return s;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / storage disabled: settings live for this session only */
  }
}

export function detectLang(languages: readonly string[]): Lang {
  const first = languages.find(Boolean) ?? 'en';
  return first.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

export function resolveLang(setting: LangSetting, languages: readonly string[]): Lang {
  return setting === 'auto' ? detectLang(languages) : setting;
}

export function resolveNaming(naming: NoteNaming | null, lang: Lang): NoteNaming {
  return naming ?? (lang === 'tr' ? 'solfege' : 'letter');
}
