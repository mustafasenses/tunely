// UI flows with the simulated engine (`?mock=<scenario>`, see src/ui/mock-engine.ts) plus a real
// denied microphone permission. Every test also asserts no console errors (helpers.ts fixture).
import {
  closeSettings,
  displayedCents,
  displayedNote,
  expect,
  horizontalOverflow,
  openSettings,
  startTuner,
  test,
  tuner,
} from './helpers';

test.describe('English (default locale)', () => {
  test('start screen loads with English copy and no console errors', async ({ page }) => {
    await page.goto('./');
    await expect(page).toHaveTitle('Tunely — Chromatic Tuner');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Start tuning' })).toBeVisible();
    await expect(page.getByText('Audio never leaves your device.')).toBeVisible();
  });

  test('letter note names by default (mock A4 −24¢ → "Too low")', async ({ page }) => {
    await startTuner(page, '?mock=flat');
    await expect.poll(() => displayedNote(page)).toBe('A4');
    await expect(tuner(page)).toHaveAttribute('data-naming', 'letter');
    await expect.poll(() => displayedCents(page)).toBe(-24);
    await expect(page.locator('#hint-text')).toHaveText('Too low — tune up ↑');
    await expect(tuner(page)).toHaveAttribute('data-zone', 'off');
  });

  test('number naming shows octave dots and persists after reload', async ({ page }) => {
    await startTuner(page, '?mock=holding'); // D5
    await expect.poll(() => displayedNote(page)).toBe('D5');
    await openSettings(page);
    await page.getByRole('radio', { name: '1 2 3' }).check();
    await closeSettings(page);
    await expect(tuner(page)).toHaveAttribute('data-naming', 'number');
    await expect.poll(() => displayedNote(page)).toBe('2');
    await expect(page.locator('#dots-above i')).toHaveCount(1);
    await expect(page.locator('#dots-below i')).toHaveCount(0);

    await page.reload();
    await page.locator('#btn-start').click();
    await expect.poll(() => displayedNote(page)).toBe('2');
    await expect(page.locator('#dots-above i')).toHaveCount(1);
  });

  test('language setting switches to Turkish and persists', async ({ page }) => {
    await page.goto('./');
    await openSettings(page);
    await page.getByRole('radio', { name: 'Türkçe' }).check();
    await expect(page.locator('#settings-title')).toHaveText('Ayarlar');
    await closeSettings(page);
    await expect(page.getByRole('button', { name: 'Akort etmeye başla' })).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(page.getByRole('button', { name: 'Akort etmeye başla' })).toBeVisible();
  });

  test('in-tune mock locks with the ✓ state', async ({ page }) => {
    await startTuner(page, '?mock=intune'); // C♯4 +1.2¢
    await expect.poll(() => displayedNote(page)).toBe('C♯4');
    await expect(page.locator('#hint-text')).toHaveText('In tune ✓');
    await expect(tuner(page)).toHaveAttribute('data-locked', 'true');
  });

  test('holding keeps the last note readable with a "Last note" tag', async ({ page }) => {
    await startTuner(page, '?mock=holding'); // D5 −3.5¢, then holding
    await expect(tuner(page)).toHaveAttribute('data-status', 'holding');
    await expect.poll(() => displayedNote(page)).toBe('D5');
    await expect(page.locator('.tag-holding')).toBeVisible();
    await expect(page.locator('.tag-holding')).toHaveText('Last note');
  });

  test('weak input shows the "play louder" hint', async ({ page }) => {
    await startTuner(page, '?mock=weak');
    await expect(page.locator('#hint-text')).toHaveText('Play louder or move closer');
  });

  test('pause / resume', async ({ page }) => {
    await startTuner(page, '?mock=sharp'); // E4 +31¢
    await expect.poll(() => displayedNote(page)).toBe('E4');
    await expect(page.locator('#hint-text')).toHaveText('Too high — tune down ↓');
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByText('Tuner paused')).toBeVisible();
    await expect.poll(() => displayedNote(page)).toBe('');
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.locator('#paused')).toBeHidden();
    await expect.poll(() => displayedNote(page)).toBe('E4');
  });

  test('reference tone plays and stops without errors', async ({ page }) => {
    await startTuner(page, '?mock=flat');
    await expect.poll(() => displayedNote(page)).toBe('A4');
    const ref = page.getByRole('button', { name: 'Play reference tone A4' });
    await ref.click();
    await expect(ref).toHaveAttribute('aria-pressed', 'true');
    // Engine is muted while the tone plays.
    await expect(tuner(page)).toHaveAttribute('data-status', 'listening');
    await expect(ref).toHaveAttribute('aria-pressed', 'false', { timeout: 4_000 });
    await expect.poll(() => displayedNote(page)).toBe('A4');
    // Tapping again while playing cancels it.
    await ref.click();
    await expect(ref).toHaveAttribute('aria-pressed', 'true');
    await ref.click();
    await expect(ref).toHaveAttribute('aria-pressed', 'false');
  });

  test('help dialog opens and closes', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'How to use' }).click();
    const help = page.getByRole('dialog', { name: 'How to use' });
    await expect(help).toBeVisible();
    await expect(help).toContainText('Kalimba tip');
    await expect(help).toContainText(/Version \d+\.\d+\.\d+/);
    await help.getByRole('button', { name: 'Close' }).click();
    await expect(help).toBeHidden();
  });
});

test.describe('Turkish locale', () => {
  test.use({ locale: 'tr-TR' });

  test('Turkish copy and solfège note names', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(page).toHaveTitle('Tunely — Kromatik Akort Aleti');
    await expect(page.getByText('Ses cihazınızdan asla çıkmaz.')).toBeVisible();
    await page.goto('./?mock=flat');
    await page.getByRole('button', { name: 'Akort etmeye başla' }).click();
    await expect.poll(() => displayedNote(page)).toBe('La4');
    await expect(tuner(page)).toHaveAttribute('data-naming', 'solfege');
    await expect(page.locator('#hint-text')).toHaveText('Pes — yükselt ↑');
    await expect(page.locator('#a4-chip')).toHaveText('La4 = 440 Hz');
    await expect(page.getByRole('button', { name: 'Duraklat' })).toBeVisible();
  });

  test('Turkish in-tune and too-high hints', async ({ page }) => {
    await startTuner(page, '?mock=intune');
    await expect.poll(() => displayedNote(page)).toBe('Do♯4');
    await expect(page.locator('#hint-text')).toHaveText('Akortlu ✓');
    await page.goto('./?mock=sharp');
    await page.locator('#btn-start').click();
    await expect.poll(() => displayedNote(page)).toBe('Mi4');
    await expect(page.locator('#hint-text')).toHaveText('Tiz — düşür ↓');
  });
});

const ERROR_CASES = [
  { mode: 'error-denied', code: 'permission-denied', title: 'Microphone access is blocked', retry: true, reload: true },
  { mode: 'error-nomic', code: 'no-microphone', title: 'No microphone found', retry: true, reload: false },
  // On plain http (localhost) "Try again" switches to https://.
  { mode: 'error-insecure', code: 'insecure-context', title: 'This page needs a secure connection', retry: true, reload: false },
  { mode: 'error-unsupported', code: 'unsupported', title: 'This browser can’t run the tuner', retry: false, reload: false },
  { mode: 'error-unknown', code: 'unknown', title: 'Something went wrong', retry: true, reload: false },
] as const;

test.describe('error states (mock)', () => {
  for (const c of ERROR_CASES) {
    test(`${c.mode} → "${c.title}"`, async ({ page }) => {
      await page.goto(`./?mock=${c.mode}`);
      await page.getByRole('button', { name: 'Start tuning' }).click();
      const view = page.locator('#view-error');
      await expect(view).toBeVisible();
      await expect(view).toHaveAttribute('data-code', c.code);
      await expect(page.getByRole('heading', { name: c.title })).toBeVisible();
      await expect(page.getByRole('heading', { name: c.title })).toBeFocused();
      await expect(page.locator('#error-body')).not.toBeEmpty();
      const retry = page.getByRole('button', { name: 'Try again' });
      await expect(retry).toBeVisible({ visible: c.retry });
      await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible({ visible: c.reload });
      if (c.retry && c.code !== 'insecure-context') {
        await retry.click();
        await expect(view).toBeVisible();
        await expect(view).toHaveAttribute('data-code', c.code);
        await expect(retry).toBeEnabled();
      }
    });
  }

  test('Turkish error copy', async ({ page }) => {
    await page.goto('./?mock=error-denied');
    await openSettings(page);
    await page.getByRole('radio', { name: 'Türkçe' }).check();
    await closeSettings(page);
    await page.getByRole('button', { name: 'Akort etmeye başla' }).click();
    await expect(page.getByRole('heading', { name: 'Mikrofon erişimi engellendi' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tekrar dene' })).toBeVisible();
  });
});

test.describe('real denied microphone permission', () => {
  test.use({ micPermission: 'deny' });

  test('real engine shows the permission-denied screen', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Start tuning' }).click();
    await expect(page.locator('#view-error')).toHaveAttribute('data-code', 'permission-denied');
    await expect(page.getByRole('heading', { name: 'Microphone access is blocked' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible();
    await expect(page.locator('#view-tuner')).toBeHidden();
  });
});

test.describe('320 px wide screen', () => {
  for (const locale of ['en-US', 'tr-TR']) {
    test.describe(locale, () => {
      test.use({ viewport: { width: 320, height: 640 }, locale });

      test('no horizontal overflow on any view or dialog', async ({ page }) => {
        await page.goto('./');
        expect(await horizontalOverflow(page), 'start').toBeLessThanOrEqual(0);

        await page.locator('#btn-settings').click();
        await expect(page.locator('#dlg-settings')).toBeVisible();
        expect(await horizontalOverflow(page), 'settings').toBeLessThanOrEqual(0);
        await page.keyboard.press('Escape');

        await page.locator('#btn-help').click();
        await expect(page.locator('#dlg-help')).toBeVisible();
        expect(await horizontalOverflow(page), 'help').toBeLessThanOrEqual(0);
        await page.keyboard.press('Escape');

        for (const mock of ['sharp', 'intune', 'weak']) {
          await page.goto(`./?mock=${mock}`);
          await page.locator('#btn-start').click();
          await expect(tuner(page)).toBeVisible();
          await expect(page.locator('#hint-text')).not.toBeEmpty();
          expect(await horizontalOverflow(page), `tuner ${mock}`).toBeLessThanOrEqual(0);
        }
        await page.locator('#btn-pause').click();
        await expect(page.locator('#paused')).toBeVisible();
        expect(await horizontalOverflow(page), 'paused').toBeLessThanOrEqual(0);

        await page.goto('./?mock=error-denied');
        await page.locator('#btn-start').click();
        await expect(page.locator('#view-error')).toBeVisible();
        expect(await horizontalOverflow(page), 'error').toBeLessThanOrEqual(0);
      });
    });
  }
});
