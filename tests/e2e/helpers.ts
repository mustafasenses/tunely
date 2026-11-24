import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

export { expect };

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

type MicPermission = 'allow' | 'deny';

/** Chromium flags for a fake microphone, optionally playing `wav` (from tests/fixtures). */
export function fakeMicArgs(wav: string | null, { loop = true, permission = 'allow' as MicPermission } = {}): string[] {
  const args = ['--use-fake-device-for-media-stream'];
  // Auto-accepts the mic prompt; otherwise the prompt is auto-denied (→ NotAllowedError).
  args.push(permission === 'allow' ? '--use-fake-ui-for-media-stream' : '--deny-permission-prompts');
  if (wav) args.push(`--use-file-for-fake-audio-capture=${FIXTURES}${wav}${loop ? '' : '%noloop'}`);
  return args;
}

type Fixtures = {
  /**
   * WAV fixture fed to the fake microphone, e.g. `test.use({ wav: 'sine-a4-440.wav' })`
   * (append `%noloop` to play it once — but note Chromium then keeps repeating the last 10 ms
   * buffer, which reads as a steady 100 Hz tone). The Chromium flag is per browser launch, so
   * tests that set this (or `micPermission`) get their own browser instance.
   */
  wav: string | null;
  /** 'deny': launch without auto-accepting the mic prompt, so getUserMedia is really refused. */
  micPermission: MicPermission;
  /** Console errors / page errors collected during the test; asserted empty afterwards. */
  consoleErrors: string[];
  /** Substrings of console errors a test expects (e.g. offline network failures). */
  allowedErrors: string[];
};

export const test = base.extend<Fixtures>({
  wav: [null, { option: true }],
  micPermission: ['allow', { option: true }],
  context: async ({ wav, micPermission, playwright, context, locale, viewport, baseURL, colorScheme }, use) => {
    if (!wav && micPermission === 'allow') {
      await use(context); // default project browser (fake device with its built-in beep)
      return;
    }
    const [file, flag] = (wav ?? '').split('%');
    const browser = await playwright.chromium.launch({
      // The headless shell can't show permission prompts at all (getUserMedia → NotSupportedError),
      // so a real "denied" needs full Chromium in new-headless mode.
      channel: micPermission === 'deny' ? 'chromium' : undefined,
      args: fakeMicArgs(file || null, { loop: flag !== 'noloop', permission: micPermission }),
    });
    const ctx = await browser.newContext({ locale, viewport, baseURL, colorScheme });
    await use(ctx);
    await ctx.close();
    await browser.close();
  },
  allowedErrors: [[], { option: true }],
  consoleErrors: [
    async ({ page, allowedErrors }, use) => {
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
      });
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
      await use(errors);
      const unexpected = errors.filter((e) => !allowedErrors.some((a) => e.includes(a)));
      expect(unexpected, 'no console errors / page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export const tuner = (page: Page) => page.locator('#view-tuner');

/** Displayed note incl. octave as plain text, e.g. "A4", "C♯5", "La4"; "" when no note. */
export async function displayedNote(page: Page): Promise<string> {
  return page.evaluate(() => {
    const name = document.querySelector('#note-name');
    if (!name || name.querySelector('.note-empty')) return '';
    return `${name.textContent ?? ''}${document.querySelector('#note-oct')?.textContent ?? ''}`.trim();
  });
}

/** Displayed cents as a number ("+8¢" → 8, "−3¢" → -3), or null when not showing a reading. */
export async function displayedCents(page: Page): Promise<number | null> {
  const text = (await page.locator('#cents').textContent()) ?? '';
  const m = /^([+−-]?)(\d+)¢$/.exec(text.trim());
  if (!m) return null;
  return (m[1] === '−' || m[1] === '-' ? -1 : 1) * Number(m[2]);
}

/** Open the app (optionally with a query such as `?mock=flat`) and press "Start tuning". */
export async function startTuner(page: Page, query = ''): Promise<void> {
  await page.goto(query ? `./${query}` : './');
  await page.locator('#btn-start').click();
  await expect(tuner(page)).toBeVisible();
}

export async function openSettings(page: Page): Promise<void> {
  await page.locator('#btn-settings').click();
  await expect(page.locator('#dlg-settings')).toBeVisible();
}

export async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('#dlg-settings')).toBeHidden();
}

/** Width overflow check: no horizontal scroll at the current viewport. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * Start recording every distinct note the readout shows (consecutive duplicates and the empty
 * state are skipped) and every tuner status change. Read back with `recordedNotes` /
 * `recordedStatuses`. A MutationObserver sees short-lived states that polling could miss.
 */
export async function recordNotes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __notes: string[]; __statuses: string[] };
    w.__notes = [];
    w.__statuses = [];
    const read = (): string => {
      const name = document.querySelector('#note-name');
      if (!name || name.querySelector('.note-empty')) return '';
      return `${name.textContent ?? ''}${document.querySelector('#note-oct')?.textContent ?? ''}`.trim();
    };
    const view = document.querySelector('#view-tuner')!;
    const status = (): void => {
      const s = view.getAttribute('data-status') ?? '';
      if (w.__statuses[w.__statuses.length - 1] !== s) w.__statuses.push(s);
    };
    status();
    new MutationObserver(status).observe(view, { attributes: true, attributeFilter: ['data-status'] });
    new MutationObserver(() => {
      const n = read();
      if (n && w.__notes[w.__notes.length - 1] !== n) w.__notes.push(n);
    }).observe(document.querySelector('#note')!, { subtree: true, childList: true, characterData: true });
  });
}

export async function recordedNotes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __notes: string[] }).__notes);
}

export async function recordedStatuses(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
}

/** True when `seq` contains `expected` as a contiguous run. */
export function containsRun(seq: string[], expected: string[]): boolean {
  for (let i = 0; i + expected.length <= seq.length; i++) {
    if (expected.every((n, j) => seq[i + j] === n)) return true;
  }
  return false;
}
