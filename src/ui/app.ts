// Tunely UI controller: views (start / tuner / error), render loop, settings, dialogs.
import { frequencyToNote, midiToFrequency, MAX_A4, MIN_A4, DEFAULT_A4, type NoteInfo } from '../music/notes';
import { TunerError, type TunerEngine, type TunerErrorCode, type TunerFrame, type TunerStatus } from '../audio/types';
import { applyI18n, currentLang, setLang, t } from '../i18n';
import { Gauge } from './gauge';
import { HistoryStrip } from './history';
import { icons, logoMark } from './icons';
import {
  Announcer,
  formatCents,
  formatHz,
  hintFor,
  LockTracker,
  noteLabel,
  noteText,
  tuneZone,
  WeakSignalTracker,
  type HintKey,
  type NoteLabel,
} from './logic';
import { ReferenceTone } from './reference-tone';
import {
  clampA4,
  loadSettings,
  resolveLang,
  resolveNaming,
  saveSettings,
  type Settings,
} from './settings';
import { KeepAwake } from './wake-lock';

declare const __APP_VERSION__: string;

type View = 'start' | 'tuner' | 'error';

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const segmented = (name: string, legendKey: string, options: [string, string][]): string => `
  <fieldset class="field">
    <legend class="field-label" data-i18n="${legendKey}"></legend>
    <div class="segmented" role="radiogroup">
      ${options
        .map(
          ([value, labelKey]) => `<label class="seg">
            <input type="radio" name="${name}" value="${value}">
            <span data-i18n="${labelKey}"></span>
          </label>`,
        )
        .join('')}
    </div>
  </fieldset>`;

const TEMPLATE = `
<div class="shell">
  <header class="topbar">
    <div class="brand">${logoMark}<span class="brand-name">Tunely</span></div>
    <div class="top-actions">
      <button type="button" class="icon-btn" id="btn-help" data-i18n-aria="openHelp">${icons.help}</button>
      <button type="button" class="icon-btn" id="btn-settings" data-i18n-aria="openSettings">${icons.settings}</button>
    </div>
  </header>

  <main class="main" id="main">
    <section class="view view-start" id="view-start" aria-labelledby="start-title">
      <div class="hero-mark" aria-hidden="true">${logoMark}</div>
      <h1 class="start-title" id="start-title">Tunely</h1>
      <p class="tagline" data-i18n="tagline"></p>
      <button type="button" class="btn btn-primary btn-xl" id="btn-start">
        ${icons.mic}<span class="btn-label" data-i18n="startButton"></span>
      </button>
      <p class="start-explain" data-i18n="startExplain"></p>
      <p class="privacy">${icons.lock}<span data-i18n="privacyNote"></span></p>
    </section>

    <section class="view view-error" id="view-error" aria-labelledby="error-title" hidden>
      <div class="error-icon" aria-hidden="true">${icons.micOff}</div>
      <h2 class="error-title" id="error-title" tabindex="-1"></h2>
      <p class="error-body" id="error-body"></p>
      <p class="error-extra" id="error-extra" hidden></p>
      <div class="error-actions">
        <button type="button" class="btn btn-primary" id="btn-retry">${icons.refresh}<span data-i18n="tryAgain"></span></button>
        <button type="button" class="btn btn-ghost" id="btn-reload" hidden><span data-i18n="reload"></span></button>
      </div>
    </section>

    <section class="view view-tuner" id="view-tuner" hidden data-status="listening" data-zone="none" data-locked="false">
      <h1 class="sr-only">Tunely</h1>
      <div class="gauge-wrap" id="gauge-wrap"></div>

      <div class="readout" id="readout">
        <div class="note-stage">
          <div class="lock-glow" aria-hidden="true"></div>
          <div class="note" id="note" aria-hidden="true">
            <span class="note-main">
              <span class="dots dots-above" id="dots-above"></span>
              <span class="note-name" id="note-name">–</span>
              <span class="dots dots-below" id="dots-below"></span>
            </span><span class="note-oct" id="note-oct"></span>
          </div>
          <button type="button" class="ref-btn" id="btn-ref">${icons.speaker}</button>
        </div>
        <div class="cents-row">
          <span class="cents" id="cents" aria-hidden="true"></span>
          <span class="lock-badge" aria-hidden="true">${icons.check}</span>
          <span class="tag-holding" data-i18n="holding"></span>
        </div>
        <p class="hint" id="hint">
          <span class="hint-icon" id="hint-icon" aria-hidden="true"></span><span class="hint-text" id="hint-text"></span>
        </p>
        <p class="freqs" id="freqs">
          <span class="freq"><span class="freq-label" data-i18n="detected"></span> <span class="freq-val" id="hz-detected">—</span></span>
          <span class="freq"><span class="freq-label" data-i18n="target"></span> <span class="freq-val" id="hz-target">—</span></span>
        </p>
      </div>

      <div class="history" id="history" role="img" data-i18n-aria="historyLabel"></div>

      <div class="level" id="level-wrap">
        <span class="level-icon" aria-hidden="true">${icons.mic}</span>
        <div class="meter" role="meter" id="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-i18n-aria="levelLabel">
          <div class="meter-fill" id="meter-fill"></div>
        </div>
      </div>

      <div class="paused" id="paused" hidden>
        <div class="paused-card">
          <p class="paused-title" data-i18n="pausedTitle"></p>
          <p class="paused-body" data-i18n="pausedBody"></p>
          <button type="button" class="btn btn-primary" id="btn-resume">${icons.play}<span data-i18n="resume"></span></button>
        </div>
      </div>
    </section>
  </main>

  <footer class="bottombar" id="bottombar" hidden>
    <button type="button" class="btn btn-ghost btn-pause" id="btn-pause">
      <span id="pause-icon">${icons.pause}</span><span id="pause-label" data-i18n="pause"></span>
    </button>
    <button type="button" class="chip" id="a4-chip"></button>
  </footer>

  <div class="sr-only" aria-live="polite" aria-atomic="true" id="live"></div>
</div>

<dialog class="sheet" id="dlg-settings" aria-labelledby="settings-title">
  <form method="dialog" class="sheet-inner">
    <div class="sheet-head">
      <h2 id="settings-title" data-i18n="settingsTitle"></h2>
      <button class="icon-btn" value="close" data-i18n-aria="close">${icons.close}</button>
    </div>
    <div class="sheet-body">
      ${segmented('lang', 'language', [
        ['auto', 'langAuto'],
        ['tr', 'langTr'],
        ['en', 'langEn'],
      ])}
      <div class="field-group">
        ${segmented('naming', 'noteNames', [
          ['letter', 'namingLetter'],
          ['solfege', 'namingSolfege'],
          ['number', 'namingNumber'],
        ])}
        <p class="field-help" data-i18n="namingHelpNumber"></p>
      </div>
      ${segmented('theme', 'theme', [
        ['auto', 'themeAuto'],
        ['dark', 'themeDark'],
        ['light', 'themeLight'],
      ])}
      <div class="field switch-field" id="field-awake">
        <label class="switch-row">
          <span class="switch-text">
            <span class="field-label" data-i18n="keepScreenOn"></span>
            <span class="field-help" data-i18n="keepScreenOnHelp"></span>
          </span>
          <input type="checkbox" role="switch" class="switch" name="keepAwake">
        </label>
      </div>
      <div class="field advanced">
        <p class="section-label" data-i18n="advanced"></p>
        <label class="field-label" for="a4-range" data-i18n="a4Reference"></label>
        <div class="a4-row">
          <button type="button" class="icon-btn round" id="a4-dec" data-i18n-aria="decrease">${icons.minus}</button>
          <output class="a4-value" id="a4-value" for="a4-range"></output>
          <button type="button" class="icon-btn round" id="a4-inc" data-i18n-aria="increase">${icons.plus}</button>
        </div>
        <input type="range" class="range" id="a4-range" min="${MIN_A4}" max="${MAX_A4}" step="1">
        <div class="a4-foot">
          <p class="field-help" data-i18n="a4Help"></p>
          <button type="button" class="btn btn-ghost btn-sm" id="a4-reset" data-i18n="reset"></button>
        </div>
      </div>
    </div>
  </form>
</dialog>

<dialog class="sheet" id="dlg-help" aria-labelledby="help-title">
  <form method="dialog" class="sheet-inner">
    <div class="sheet-head">
      <h2 id="help-title" data-i18n="helpTitle"></h2>
      <button class="icon-btn" value="close" data-i18n-aria="close">${icons.close}</button>
    </div>
    <div class="sheet-body">
      <ol class="steps">
        <li><span class="step-num" aria-hidden="true">1</span><div><h3 data-i18n="helpStep1Title"></h3><p data-i18n="helpStep1"></p></div></li>
        <li><span class="step-num" aria-hidden="true">2</span><div><h3 data-i18n="helpStep2Title"></h3><p data-i18n="helpStep2"></p></div></li>
        <li><span class="step-num" aria-hidden="true">3</span><div><h3 data-i18n="helpStep3Title"></h3><p data-i18n="helpStep3"></p></div></li>
      </ol>
      <p class="tip" data-i18n="helpKalimbaTip"></p>
      <div class="legend" aria-hidden="true">
        <span class="legend-item z-off" data-i18n="hintLow"></span>
        <span class="legend-item z-in" data-i18n="hintInTune"></span>
        <span class="legend-item z-off" data-i18n="hintHigh"></span>
      </div>
      <section class="about" aria-labelledby="about-title">
        <h3 id="about-title" data-i18n="aboutTitle"></h3>
        <p class="about-version" id="about-version"></p>
        <p>${icons.lock}<span data-i18n="aboutPrivacy"></span></p>
        <p data-i18n="aboutOffline"></p>
      </section>
    </div>
  </form>
</dialog>
`;

interface Display {
  status: TunerStatus;
  info: NoteInfo | null;
  label: NoteLabel | null;
  hint: HintKey;
  locked: boolean;
}

export interface AppOptions {
  engine: TunerEngine;
  root: HTMLElement;
}

export function mountApp({ engine, root }: AppOptions): void {
  root.innerHTML = TEMPLATE;
  const settingsDlg = $<HTMLDialogElement>(root, '#dlg-settings');
  const helpDlg = $<HTMLDialogElement>(root, '#dlg-help');
  const form = $<HTMLFormElement>(settingsDlg, 'form');
  const tuner = $(root, '#view-tuner');
  const views: Record<View, HTMLElement> = {
    start: $(root, '#view-start'),
    tuner,
    error: $(root, '#view-error'),
  };
  const el = {
    noteName: $(root, '#note-name'),
    noteOct: $(root, '#note-oct'),
    note: $(root, '#note'),
    dotsAbove: $(root, '#dots-above'),
    dotsBelow: $(root, '#dots-below'),
    cents: $(root, '#cents'),
    hintIcon: $(root, '#hint-icon'),
    hintText: $(root, '#hint-text'),
    hzDetected: $(root, '#hz-detected'),
    hzTarget: $(root, '#hz-target'),
    meter: $(root, '#meter'),
    meterFill: $(root, '#meter-fill'),
    live: $(root, '#live'),
    paused: $(root, '#paused'),
    bottombar: $(root, '#bottombar'),
    pauseIcon: $(root, '#pause-icon'),
    pauseLabel: $(root, '#pause-label'),
    a4Chip: $(root, '#a4-chip'),
    refBtn: $<HTMLButtonElement>(root, '#btn-ref'),
    startBtn: $<HTMLButtonElement>(root, '#btn-start'),
    retryBtn: $<HTMLButtonElement>(root, '#btn-retry'),
    reloadBtn: $<HTMLButtonElement>(root, '#btn-reload'),
    errorTitle: $(root, '#error-title'),
    errorBody: $(root, '#error-body'),
    errorExtra: $(root, '#error-extra'),
    a4Value: $(root, '#a4-value'),
    a4Range: $<HTMLInputElement>(root, '#a4-range'),
  };

  const reducedMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  const gauge = new Gauge(() => reducedMotionMq.matches);
  $(root, '#gauge-wrap').appendChild(gauge.el);
  const history = new HistoryStrip();
  $(root, '#history').appendChild(history.el);
  const tone = new ReferenceTone();
  const keepAwake = new KeepAwake();
  if (!KeepAwake.supported) $(root, '#field-awake').hidden = true;
  if (!tone.supported) el.refBtn.hidden = true;
  $(root, '#about-version').dataset.version = __APP_VERSION__;

  let settings: Settings = loadSettings();
  let view: View = 'start';
  let errorCode: TunerErrorCode | null = null;
  let paused = false;
  let starting = false;
  let resumeOnVisible = false;

  // ---------- settings / i18n / theme ----------

  const languages = (): readonly string[] =>
    navigator.languages?.length ? navigator.languages : [navigator.language];
  const naming = () => resolveNaming(settings.naming, currentLang());

  function applyTheme(): void {
    const resolved = settings.theme === 'auto' ? (darkMq.matches ? 'dark' : 'light') : settings.theme;
    const html = document.documentElement;
    html.dataset.theme = resolved;
    html.style.colorScheme = resolved;
    const color = getComputedStyle(html).getPropertyValue('--bg').trim();
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
      if (settings.theme === 'auto') {
        m.content = m.media.includes('dark') ? '#0e1013' : '#f5f4f0';
      } else if (color) {
        m.content = color;
      }
    });
    history.refreshPalette();
  }

  function applyLang(): void {
    setLang(resolveLang(settings.lang, languages()));
    applyI18n(root);
    $(root, '#about-version').textContent = t().version(__APP_VERSION__);
    renderA4();
    if (errorCode) renderError(errorCode);
    renderPauseButton();
    lastKey = '';
    renderDisplay(true);
  }

  function renderA4(): void {
    el.a4Chip.textContent = t().a4Chip(settings.a4);
    el.a4Chip.classList.toggle('chip-custom', settings.a4 !== DEFAULT_A4);
    el.a4Value.textContent = `${settings.a4} Hz`;
    el.a4Range.value = String(settings.a4);
    const reset = $<HTMLButtonElement>(root, '#a4-reset');
    reset.disabled = settings.a4 === DEFAULT_A4;
  }

  function syncForm(): void {
    const set = (name: string, value: string): void => {
      form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((i) => {
        i.checked = i.value === value;
      });
    };
    set('lang', settings.lang);
    set('naming', naming());
    set('theme', settings.theme);
    $<HTMLInputElement>(form, 'input[name="keepAwake"]').checked = settings.keepAwake;
    renderA4();
  }

  function update(patch: Partial<Settings>): void {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    if ('lang' in patch) applyLang();
    if ('theme' in patch) applyTheme();
    if ('a4' in patch) {
      renderA4();
      reprocess();
    }
    if ('naming' in patch) {
      lastKey = '';
      renderDisplay(true);
    }
    if ('keepAwake' in patch) syncWakeLock();
    syncForm();
  }

  form.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    switch (input.name) {
      case 'lang':
        update({ lang: input.value as Settings['lang'] });
        break;
      case 'naming':
        update({ naming: input.value as Settings['naming'] });
        break;
      case 'theme':
        update({ theme: input.value as Settings['theme'] });
        break;
      case 'keepAwake':
        update({ keepAwake: input.checked });
        break;
    }
  });
  el.a4Range.addEventListener('input', () => update({ a4: clampA4(Number(el.a4Range.value)) }));
  $(root, '#a4-dec').addEventListener('click', () => update({ a4: clampA4(settings.a4 - 1) }));
  $(root, '#a4-inc').addEventListener('click', () => update({ a4: clampA4(settings.a4 + 1) }));
  $(root, '#a4-reset').addEventListener('click', () => update({ a4: DEFAULT_A4 }));

  darkMq.addEventListener('change', () => settings.theme === 'auto' && applyTheme());
  window.addEventListener('languagechange', () => settings.lang === 'auto' && applyLang());

  // ---------- dialogs ----------

  function openDialog(d: HTMLDialogElement): void {
    if (d.open) return;
    if (d === settingsDlg) syncForm();
    d.showModal();
  }
  for (const d of [settingsDlg, helpDlg]) {
    // Close when clicking the backdrop.
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
  }
  $(root, '#btn-settings').addEventListener('click', () => openDialog(settingsDlg));
  $(root, '#btn-help').addEventListener('click', () => openDialog(helpDlg));
  el.a4Chip.addEventListener('click', () => {
    openDialog(settingsDlg);
    el.a4Range.focus();
  });

  // ---------- views ----------

  function showView(v: View): void {
    view = v;
    for (const [k, node] of Object.entries(views)) node.hidden = k !== v;
    el.bottombar.hidden = v !== 'tuner';
    document.documentElement.dataset.view = v;
  }

  function renderError(code: TunerErrorCode): void {
    const d = t();
    el.errorTitle.textContent = d.errorTitle[code];
    el.errorBody.textContent = d.errorBody[code];
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    el.errorExtra.hidden = !(code === 'permission-denied' && ios);
    el.errorExtra.textContent = d.errorIosHint;
    el.retryBtn.hidden = code === 'unsupported' || (code === 'insecure-context' && location.protocol !== 'http:');
    el.reloadBtn.hidden = code !== 'permission-denied';
    views.error.dataset.code = code;
  }

  function showError(code: TunerErrorCode): void {
    errorCode = code;
    renderError(code);
    showView('error');
    el.errorTitle.focus();
  }

  function renderPauseButton(): void {
    el.pauseIcon.innerHTML = paused ? icons.play : icons.pause;
    el.pauseLabel.textContent = paused ? t().resume : t().pause;
    el.paused.hidden = !paused;
    // The overlay carries the Resume action; avoid a duplicate button in the bar.
    $(root, '#btn-pause').style.visibility = paused ? 'hidden' : '';
    tuner.classList.toggle('is-paused', paused);
  }

  async function start(): Promise<void> {
    if (starting) return;
    starting = true;
    el.startBtn.disabled = true;
    el.retryBtn.disabled = true;
    root.classList.add('is-starting');
    const startLabel = $(el.startBtn, '.btn-label');
    startLabel.textContent = t().starting;
    try {
      await engine.start();
      errorCode = null;
      paused = false;
      resetTracking();
      renderPauseButton();
      showView('tuner');
      syncWakeLock();
      loop.ensure();
    } catch (err) {
      showError(err instanceof TunerError ? err.code : 'unknown');
    } finally {
      starting = false;
      el.startBtn.disabled = false;
      el.retryBtn.disabled = false;
      root.classList.remove('is-starting');
      startLabel.textContent = t().startButton;
    }
  }

  function pause(): void {
    tone.cancel();
    engine.stop();
    paused = true;
    frame = null;
    renderPauseButton();
    syncWakeLock();
    resetTracking();
    lastKey = '';
    renderDisplay(true);
  }

  el.startBtn.addEventListener('click', () => void start());
  el.retryBtn.addEventListener('click', () => {
    if (errorCode === 'insecure-context' && location.protocol === 'http:') {
      location.replace(location.href.replace(/^http:/, 'https:'));
    } else void start();
  });
  el.reloadBtn.addEventListener('click', () => location.reload());
  $(root, '#btn-resume').addEventListener('click', () => void start());
  $(root, '#btn-pause').addEventListener('click', () => (paused ? void start() : pause()));

  function syncWakeLock(): void {
    keepAwake.set(settings.keepAwake && view === 'tuner' && !paused && engine.running);
  }

  // Release the mic when the page is hidden; resume when visible again.
  const onHidden = (): void => {
    if (view === 'tuner' && !paused && engine.running) {
      resumeOnVisible = true;
      tone.cancel();
      engine.stop();
      frame = null;
      resetTracking();
    }
  };
  const onVisible = (): void => {
    if (!resumeOnVisible) return;
    resumeOnVisible = false;
    engine
      .start()
      .then(() => {
        syncWakeLock();
        loop.ensure();
      })
      .catch((err) => {
        if (err instanceof TunerError && err.code === 'permission-denied') showError(err.code);
        else pause(); // e.g. audio needs a fresh tap on some browsers → show "Resume"
      });
  };
  document.addEventListener('visibilitychange', () =>
    document.visibilityState === 'hidden' ? onHidden() : onVisible(),
  );
  window.addEventListener('pagehide', onHidden);
  window.addEventListener('pageshow', (e) => e.persisted && onVisible());

  // ---------- reference tone ----------

  let lastMidi: number | null = null;
  el.refBtn.addEventListener('click', () => {
    if (tone.playing) {
      tone.cancel();
      return;
    }
    const midi = lastMidi ?? 69;
    void tone.play(
      midiToFrequency(midi, settings.a4),
      () => {
        engine.setMuted(true);
        el.refBtn.classList.add('is-playing');
        el.refBtn.setAttribute('aria-pressed', 'true');
      },
      () => {
        engine.setMuted(false);
        el.refBtn.classList.remove('is-playing');
        el.refBtn.setAttribute('aria-pressed', 'false');
      },
    );
  });

  // ---------- frame processing ----------

  let frame: TunerFrame | null = null;
  let display: Display = { status: 'listening', info: null, label: null, hint: 'hintListening', locked: false };
  const lock = new LockTracker();
  const weak = new WeakSignalTracker();
  const announcer = new Announcer();
  let level = 0;
  let pulseAt = 0;

  function resetTracking(): void {
    lock.reset();
    weak.reset();
    history.clear();
    display = { status: 'listening', info: null, label: null, hint: 'hintListening', locked: false };
    gauge.setCents(null);
  }

  function process(f: TunerFrame): void {
    const info = f.reading && f.status !== 'listening' ? frequencyToNote(f.reading.frequency, settings.a4) : null;
    const isWeak = weak.update(info ? f.status : 'listening', f.level, f.time);
    const justLocked = lock.update(f.status, info?.midi ?? null, info?.cents ?? null, f.time);
    const label = info ? noteLabel(info.pitchClass, info.octave, naming()) : null;
    display = {
      status: info ? f.status : 'listening',
      info,
      label,
      hint: hintFor(f.status, info?.cents ?? null, isWeak),
      locked: lock.locked,
    };
    if (info) lastMidi = info.midi;
    history.push(f.time, f.status === 'detected' ? (info?.midi ?? null) : null, f.status === 'detected' ? (info?.cents ?? null) : null);
    level = f.level;
    gauge.setCents(info?.cents ?? null);

    if (justLocked) {
      pulseAt = performance.now();
      try {
        navigator.vibrate?.(35);
      } catch {
        /* ignore */
      }
    }
    const say = announcer.update(f.status === 'detected' ? (info?.midi ?? null) : null, justLocked, f.time);
    if (say && info && label) announce(say, info, label);
  }

  /** Recompute display after A4 changes without waiting for the next frame. */
  function reprocess(): void {
    if (frame) process(frame);
    lastKey = '';
  }

  function announce(kind: 'note' | 'lock', info: NoteInfo, label: NoteLabel): void {
    const d = t();
    const name = noteText(label, d.srOctave(info.octave));
    const c = Math.round(Math.abs(info.cents));
    let msg: string;
    if (kind === 'lock' || tuneZone(info.cents) === 'in') msg = d.srInTune(name);
    else msg = info.cents < 0 ? d.srLow(name, c) : d.srHigh(name, c);
    el.live.textContent = msg;
  }

  engine.onFrame((f) => {
    if (paused) return;
    frame = f;
    process(f);
  });

  // ---------- render ----------

  let lastKey = '';

  function renderDisplay(force = false): void {
    const d = t();
    const { status, info, label, hint, locked } = display;
    const zone = info ? tuneZone(info.cents) : 'none';
    const centsText = info ? formatCents(info.cents) : '';
    const key = [status, label?.name, label?.octave, label?.dots, centsText, hint, locked, zone, info ? formatHz(info.targetFrequency) : '', paused].join('|');
    // Detected Hz changes every frame: update it separately (cheap text set).
    if (info && frame?.reading) {
      const hz = `${formatHz(frame.reading.frequency)} Hz`;
      if (el.hzDetected.textContent !== hz) el.hzDetected.textContent = hz;
    }
    if (!force && key === lastKey) return;
    lastKey = key;

    tuner.dataset.status = status;
    tuner.dataset.zone = zone;
    tuner.dataset.locked = String(locked);
    tuner.dataset.naming = naming();

    if (label) {
      // Accidental rendered as a raised, smaller glyph ("C♯", "♯4" in number notation).
      const base = label.name.replace('♯', '');
      const acc = '<span class="acc">♯</span>';
      el.noteName.innerHTML = label.name.startsWith('♯')
        ? `${acc}${base}`
        : label.name.endsWith('♯')
          ? `${base}${acc}`
          : base;
      el.noteName.classList.toggle('has-pre-acc', label.name.startsWith('♯'));
      el.noteOct.textContent = label.octave ?? '';
      const above = Math.max(0, label.dots);
      const below = Math.max(0, -label.dots);
      el.dotsAbove.innerHTML = '<i></i>'.repeat(Math.min(above, 4));
      el.dotsBelow.innerHTML = '<i></i>'.repeat(Math.min(below, 4));
      el.note.dataset.len = String(Math.min(4, base.length + (label.octave ? 1 : 0)));
    } else {
      el.noteName.innerHTML = '<span class="note-empty">♪</span>';
      el.noteName.classList.remove('has-pre-acc');
      el.noteOct.textContent = '';
      el.dotsAbove.innerHTML = '';
      el.dotsBelow.innerHTML = '';
      el.note.dataset.len = '1';
    }
    el.cents.textContent = info ? centsText : d.listening;
    el.hintText.textContent = d[hint];
    // Directional hints already carry ↑ / ↓ / ✓ in their text; only the idle hints get an icon.
    el.hintIcon.innerHTML = hint === 'hintListening' ? icons.ear : hint === 'hintWeak' ? icons.mic : '';
    el.hintIcon.hidden = el.hintIcon.innerHTML === '';
    if (info) {
      el.hzTarget.textContent = `${formatHz(info.targetFrequency)} Hz`;
    } else {
      el.hzDetected.textContent = '—';
      el.hzTarget.textContent = '—';
    }
    const refNote = label ? noteText(label, d.srOctave(info!.octave)) : lastMidi !== null ? refName(lastMidi) : refName(69);
    el.refBtn.setAttribute('aria-label', d.refTone(refNote));
    el.refBtn.title = d.refTone(refNote);
  }

  function refName(midi: number): string {
    const pc = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return noteText(noteLabel(pc, oct, naming()), t().srOctave(oct));
  }

  let shownLevel = 0;
  let lastPulse = 0;

  const loop = {
    raf: 0,
    last: 0,
    ensure(): void {
      if (this.raf) return;
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    },
    tick: (now: number): void => {
      const dt = Math.max(0, (now - loop.last) / 1000);
      loop.last = now;
      renderDisplay();
      gauge.step(dt);
      // Level meter: fast attack, slower release.
      const target = paused ? 0 : level;
      shownLevel = target > shownLevel ? target : shownLevel + (target - shownLevel) * Math.min(1, dt * 6);
      el.meterFill.style.transform = `scaleX(${shownLevel.toFixed(3)})`;
      const pct = String(Math.round(shownLevel * 100));
      if (el.meter.getAttribute('aria-valuenow') !== pct) el.meter.setAttribute('aria-valuenow', pct);
      history.draw(now);
      if (pulseAt !== lastPulse) {
        lastPulse = pulseAt;
        tuner.classList.remove('pulse');
        void tuner.offsetWidth; // restart CSS animation
        tuner.classList.add('pulse');
      }
      if (view === 'tuner' && document.visibilityState === 'visible') {
        loop.raf = requestAnimationFrame(loop.tick);
      } else {
        loop.raf = 0;
      }
    },
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && view === 'tuner') loop.ensure();
  });

  // ---------- boot ----------
  applyTheme();
  applyLang();
  syncForm();
  showView('start');
}
