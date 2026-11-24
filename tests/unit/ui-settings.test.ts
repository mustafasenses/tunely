import { describe, expect, it } from 'vitest';
import { clampA4, DEFAULT_SETTINGS, detectLang, resolveLang, resolveNaming, sanitizeSettings } from '../../src/ui/settings';
import { DICTS } from '../../src/i18n/strings';

describe('settings', () => {
  it('detects language from navigator.languages', () => {
    expect(detectLang(['tr-TR', 'en'])).toBe('tr');
    expect(detectLang(['TR'])).toBe('tr');
    expect(detectLang(['en-GB', 'tr'])).toBe('en');
    expect(detectLang(['de'])).toBe('en');
    expect(detectLang([])).toBe('en');
    expect(resolveLang('en', ['tr-TR'])).toBe('en');
    expect(resolveLang('auto', ['tr-TR'])).toBe('tr');
  });

  it('defaults note naming by language unless chosen', () => {
    expect(resolveNaming(null, 'tr')).toBe('solfege');
    expect(resolveNaming(null, 'en')).toBe('letter');
    expect(resolveNaming('number', 'tr')).toBe('number');
  });

  it('clamps A4 to 415–466, integer', () => {
    expect(clampA4(400)).toBe(415);
    expect(clampA4(500)).toBe(466);
    expect(clampA4(441.6)).toBe(442);
    expect(clampA4(Number.NaN)).toBe(440);
  });

  it('sanitizes untrusted stored data', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(
      sanitizeSettings({ lang: 'fr', naming: 'solfege', a4: 1000, keepAwake: 'yes', theme: 'light' }),
    ).toEqual({ ...DEFAULT_SETTINGS, naming: 'solfege', a4: 466, theme: 'light' });
  });
});

describe('i18n dictionaries', () => {
  it('TR and EN have the same keys and spec hint copy', () => {
    expect(Object.keys(DICTS.tr).sort()).toEqual(Object.keys(DICTS.en).sort());
    expect(DICTS.en.hintLow).toBe('Too low — tune up ↑');
    expect(DICTS.en.hintHigh).toBe('Too high — tune down ↓');
    expect(DICTS.en.hintInTune).toBe('In tune ✓');
    expect(DICTS.tr.hintLow).toBe('Pes — yükselt ↑');
    expect(DICTS.tr.hintHigh).toBe('Tiz — düşür ↓');
    expect(DICTS.tr.hintInTune).toBe('Akortlu ✓');
  });
});
