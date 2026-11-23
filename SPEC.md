# Tunely — Product Spec (source of truth)

Online **chromatic tuner** web app, hosted on GitHub Pages at `https://<user>.github.io/tunely/`.
Primary user: a beginner who mainly tunes a **kalimba**, but the app is a general chromatic tuner
(any instrument / voice). Priorities, in order: **accuracy**, **intuitiveness**, polish.

## Tech
- Vite + TypeScript, **no UI framework**. `npm run dev`, `npm run build`, `npm test` (vitest).
- `base: '/tunely/'` (see `vite.config.ts`). All assets bundled — no external fonts/CDNs (must work offline).
- Code layout / ownership:
  - `src/music/notes.ts` — pure note math (shared; exists).
  - `src/audio/types.ts` — **shared contract** engine ↔ UI (exists; don't change signatures).
  - `src/audio/**` — mic capture + pitch detection engine (`createTunerEngine(): TunerEngine`).
  - `src/ui/**`, `src/main.ts`, `src/styles/**`, `index.html`, `public/**` — UI, i18n, PWA.
  - `tests/unit/**` — vitest; `tests/e2e/**` — Playwright (later phase).

## Accuracy requirements (engine)
- Detection range ≈ 30 Hz – 4.2 kHz (low bass to above kalimba's highest tines ~E6–C7).
- Clean sine / harmonic tones: error ≤ **±1 cent** across 40 Hz – 2.5 kHz.
- With noise (SNR ~20 dB) and rich harmonics: ≤ ±3 cents, correct octave.
- **Kalimba-like signal** (sharp attack, exponential decay ~0.5–2 s, strong inharmonic 2nd mode at ~5–7× f0,
  some 2×/3× content): correct note & octave, ≤ ±3 cents during sustain.
- Stable display: no jitter > ~1 cent on steady tones; reject octave jumps / spurious frames;
  after signal decays keep last good reading (`holding`) ~1.5 s, then `listening`.
- getUserMedia with `echoCancellation`, `noiseSuppression`, `autoGainControl` all **false**.
- Must work in Chrome, Firefox, Safari (desktop + iOS/Android). AudioContext created/resumed on user gesture.
- Latency: first reading within ~150 ms of a note onset where possible.

## UX requirements (UI)
- Mobile-first, one main screen, works at 320 px width, no horizontal scroll. Dark theme default, light via
  `prefers-color-scheme` or manual setting.
- **Start screen**: big "Start tuning" button (mic needs user gesture), one-line explanation, privacy note
  ("audio never leaves your device").
- **Main tuner view**:
  - Large note name + octave (according to naming setting), cents value (e.g. `+12¢`), detected Hz,
    target Hz (small).
  - **Needle gauge** ±50 cents (SVG), smooth animated needle (respect `prefers-reduced-motion`).
    Colour feedback: in tune |c| ≤ 5 → green; ≤ 15 → amber; else red/orange.
  - **Plain-language direction hint** for beginners: "Too low — tune up ↑" / "Too high — tune down ↓" /
    "In tune ✓". (TR: "Pes — yükselt ↑", "Tiz — düşür ↓", "Akortlu ✓").
  - **In-tune lock**: |c| ≤ 3 sustained ~350 ms → celebratory ✓ state (subtle pulse, short haptic via
    `navigator.vibrate` if available).
  - **Pitch history strip**: last ~5 s of cents deviation as a small line graph (shows stability; useful
    for decaying kalimba notes).
  - Input level meter + hint when signal too weak ("Play louder or move closer").
  - `holding` state visually dimmed but readable.
  - **Reference tone** button (speaker icon) next to the note: plays the nearest target note for ~1.5 s
    (pleasant sine + soft partial, envelope). Engine `setMuted(true)` while playing.
- **Settings** (sheet/dialog), persisted in localStorage:
  - Language: Auto / Türkçe / English.
  - Note names: Letter (C D E) / Solfège (Do Re Mi) / Numbers (1 2 3, octave as dots above/below relative to
    octave 4). Default: TR → solfège, EN → letter.
  - A4 reference: 415–466 Hz, step 1, reset to 440 (labelled "Advanced").
  - Keep screen on (Wake Lock API, default on, hidden if unsupported).
  - Theme: Auto / Dark / Light.
- **Help** ("How to use", 3 short steps) + About (version, privacy).
- Error states with human, actionable text: permission denied (how to re-enable), no mic, insecure context,
  unsupported browser.
- i18n: **Turkish + English**, auto from `navigator.language` (tr* → TR, else EN); all strings in one
  dictionary file; `<html lang>` updated.
- Accessibility: semantic HTML, keyboard operable, visible focus, `aria-live` (polite, throttled) announcing
  note + state, contrast AA.
- **PWA**: manifest (name "Tunely", icons 192/512 + maskable, theme colour), service worker precaching the
  app shell → works offline and is installable. Must work under `/tunely/` base.

## Delivery
- GitHub Actions workflow deploying `dist/` to GitHub Pages on push to `main`
  (actions/configure-pages, upload-pages-artifact, deploy-pages). Runs tests + build first.
- README in Turkish (with short English section): what it is, how to use, dev commands, deploy steps.
