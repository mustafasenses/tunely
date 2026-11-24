// Tiny i18n runtime: one active dictionary, declarative DOM bindings via data attributes.
//   data-i18n="key"        → textContent
//   data-i18n-aria="key"   → aria-label (+ title, for tooltips on icon buttons)
import { DICTS, type Dict, type Lang } from './strings';

export type { Dict, Lang };

let lang: Lang = 'en';
let dict: Dict = DICTS.en;

export const t = (): Dict => dict;
export const currentLang = (): Lang => lang;

function str(key: string): string | null {
  const v = (dict as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

export function setLang(next: Lang): void {
  lang = next;
  dict = DICTS[next];
  const html = document.documentElement;
  html.lang = next;
  document.title = dict.appTitle;
  document.querySelector('meta[name="description"]')?.setAttribute('content', dict.metaDescription);
}

export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const v = str(el.dataset.i18n!);
    if (v !== null) el.textContent = v;
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    const v = str(el.dataset.i18nAria!);
    if (v !== null) {
      el.setAttribute('aria-label', v);
      el.title = v;
    }
  });
}
