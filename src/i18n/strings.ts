// All user-facing strings, one dictionary per language.
// `tr` is typed against `en`, so a missing key is a compile error.

export type Lang = 'en' | 'tr';

const en = {
  appTitle: 'Tunely — Chromatic Tuner',
  metaDescription:
    'Tunely is a free, accurate chromatic tuner for kalimba, guitar, ukulele, voice and more. Works offline — audio never leaves your device.',
  tagline: 'An accurate chromatic tuner for kalimba, guitar, voice and more.',

  // Start screen
  startButton: 'Start tuning',
  startExplain: 'Tunely listens through your microphone and shows how close each note is.',
  privacyNote: 'Audio never leaves your device.',
  starting: 'Starting…',

  // Header / controls
  openHelp: 'How to use',
  openSettings: 'Settings',
  close: 'Close',
  pause: 'Pause',
  resume: 'Resume',
  pausedTitle: 'Tuner paused',
  pausedBody: 'The microphone is off.',
  endedTitle: 'Microphone stopped',
  endedBody: 'The microphone was disconnected or switched off. Check it, then tap Resume.',
  suspendedTitle: 'Listening paused',
  suspendedBody: 'Your browser paused the audio. Tap Resume to keep tuning.',

  // Tuner readout
  listening: 'Listening…',
  holding: 'Last note',
  hintListening: 'Play one note and let it ring',
  hintWeak: 'Play louder or move closer',
  hintMicMuted: 'The microphone is in use by another app',
  hintLow: 'Too low — tune up ↑',
  hintHigh: 'Too high — tune down ↓',
  hintInTune: 'In tune ✓',
  centsUnit: 'cents',
  detected: 'Detected',
  target: 'Target',
  historyLabel: 'Pitch over the last 5 seconds',
  levelLabel: 'Input level',
  refTone: (note: string) => `Play reference tone ${note}`,
  a4Chip: (hz: number) => `A4 = ${hz} Hz`,

  // Screen-reader announcements
  srInTune: (note: string) => `${note}, in tune`,
  srLow: (note: string, c: number) => `${note}, ${c} cents low`,
  srHigh: (note: string, c: number) => `${note}, ${c} cents high`,
  srOctave: (o: number) => `octave ${o}`,

  // Settings
  settingsTitle: 'Settings',
  language: 'Language',
  langAuto: 'Auto',
  langTr: 'Türkçe',
  langEn: 'English',
  noteNames: 'Note names',
  namingLetter: 'C D E',
  namingSolfege: 'Do Re Mi',
  namingNumber: '1 2 3',
  namingHelpNumber: 'Numbers: dots above or below show the octave (no dots = octave 4).',
  theme: 'Theme',
  themeAuto: 'Auto',
  themeDark: 'Dark',
  themeLight: 'Light',
  keepScreenOn: 'Keep screen on',
  keepScreenOnHelp: 'Stops the screen dimming while you tune.',
  advanced: 'Advanced',
  a4Reference: 'Reference pitch (A4)',
  a4Help: 'Leave at 440 Hz unless your band or instrument uses another standard.',
  decrease: 'Decrease',
  increase: 'Increase',
  reset: 'Reset to 440',

  // Help / About
  helpTitle: 'How to use',
  helpStep1Title: 'Allow the microphone',
  helpStep1: 'Tap “Start tuning” and allow microphone access when your browser asks.',
  helpStep2Title: 'Play one note at a time',
  helpStep2: 'Pluck a single tine or string and let it ring. Keep other notes quiet.',
  helpStep3Title: 'Adjust until it turns green',
  helpStep3:
    'Turn the tuning peg, or gently slide the kalimba tine, until the needle is centred and turns green.',
  helpKalimbaTip:
    'Kalimba tip: a shorter tine sounds higher. Push the tine toward the bridge to raise the pitch, pull it out to lower it.',
  aboutTitle: 'About',
  version: (v: string) => `Version ${v}`,
  build: (b: string) => `Build ${b}`,
  aboutPrivacy:
    'Privacy: all pitch detection happens on your device. Audio is never recorded, stored or sent anywhere.',
  aboutOffline: 'Works offline once loaded. You can add it to your home screen.',

  // Errors
  errorTitle: {
    'permission-denied': 'Microphone access is blocked',
    'no-microphone': 'No microphone found',
    'insecure-context': 'This page needs a secure connection',
    unsupported: 'This browser can’t run the tuner',
    'mic-busy': 'The microphone is busy',
    unknown: 'Something went wrong',
  },
  errorBody: {
    'permission-denied':
      'Tunely needs the microphone to hear your instrument. To allow it again: tap the lock or settings icon next to the address bar, set Microphone to “Allow”, then try again.',
    'no-microphone':
      'Connect a microphone or headset, and check that no other app is using it. Then try again.',
    'insecure-context':
      'Browsers only allow the microphone on secure (https://) pages. Open Tunely using its https:// address.',
    unsupported:
      'Please open Tunely in an up-to-date Chrome, Firefox, Safari or Edge.',
    'mic-busy':
      'Another app (for example a call, a video meeting or a recorder) is using the microphone. Close it, then try again.',
    unknown: 'The microphone could not be started. Please try again.',
  },
  errorIosHint: 'On iPhone/iPad: Settings → Safari → Microphone → Allow, then reload.',
  tryAgain: 'Try again',
  reload: 'Reload page',
};

export type Dict = typeof en;

const tr: Dict = {
  appTitle: 'Tunely — Kromatik Akort Aleti',
  metaDescription:
    'Tunely; kalimba, gitar, ukulele, insan sesi ve daha fazlası için ücretsiz ve hassas bir kromatik akort aleti. Çevrimdışı çalışır — sesiniz cihazınızdan hiçbir yere gönderilmez.',
  tagline: 'Kalimba, gitar, insan sesi ve daha fazlası için hassas bir kromatik akort aleti.',

  startButton: 'Akort etmeye başla',
  startExplain: 'Tunely mikrofon üzerinden dinler ve çaldığınız notanın doğru perdeye ne kadar yakın olduğunu gösterir.',
  privacyNote: 'Sesiniz cihazınızdan hiçbir yere gönderilmez.',
  starting: 'Başlatılıyor…',

  openHelp: 'Nasıl kullanılır',
  openSettings: 'Ayarlar',
  close: 'Kapat',
  pause: 'Duraklat',
  resume: 'Devam et',
  pausedTitle: 'Akort aleti duraklatıldı',
  pausedBody: 'Mikrofon kapalı.',
  endedTitle: 'Mikrofon durdu',
  endedBody: 'Mikrofonun bağlantısı kesildi ya da mikrofon kapatıldı. Kontrol edip “Devam et”e dokunun.',
  suspendedTitle: 'Dinleme duraklatıldı',
  suspendedBody: 'Tarayıcı sesi duraklattı. Akort etmeye devam etmek için “Devam et”e dokunun.',

  listening: 'Dinleniyor…',
  holding: 'Son nota',
  hintListening: 'Tek bir nota çalın ve tınlamasını bekleyin',
  hintWeak: 'Daha güçlü çalın ya da mikrofona yaklaşın',
  hintMicMuted: 'Mikrofon başka bir uygulama tarafından kullanılıyor',
  hintLow: 'Pes — yükselt ↑',
  hintHigh: 'Tiz — düşür ↓',
  hintInTune: 'Akortlu ✓',
  centsUnit: 'sent',
  detected: 'Algılanan',
  target: 'Hedef',
  historyLabel: 'Son 5 saniyedeki perde değişimi',
  levelLabel: 'Giriş seviyesi',
  refTone: (note: string) => `${note} referans sesini çal`,
  a4Chip: (hz: number) => `La4 = ${hz} Hz`,

  srInTune: (note: string) => `${note}, akortlu`,
  srLow: (note: string, c: number) => `${note}, ${c} sent pes`,
  srHigh: (note: string, c: number) => `${note}, ${c} sent tiz`,
  srOctave: (o: number) => `${o}. oktav`,

  settingsTitle: 'Ayarlar',
  language: 'Dil',
  langAuto: 'Otomatik',
  langTr: 'Türkçe',
  langEn: 'English',
  noteNames: 'Nota adları',
  namingLetter: 'C D E',
  namingSolfege: 'Do Re Mi',
  namingNumber: '1 2 3',
  namingHelpNumber: 'Sayılar: üstteki veya alttaki noktalar oktavı gösterir (nokta yok = 4. oktav).',
  theme: 'Tema',
  themeAuto: 'Otomatik',
  themeDark: 'Koyu',
  themeLight: 'Açık',
  keepScreenOn: 'Ekranı açık tut',
  keepScreenOnHelp: 'Akort ederken ekranın kararmasını önler.',
  advanced: 'Gelişmiş',
  a4Reference: 'Referans perde (La4 / A4)',
  a4Help: 'Grubunuz veya enstrümanınız farklı bir standart kullanmıyorsa 440 Hz’de bırakın.',
  decrease: 'Azalt',
  increase: 'Artır',
  reset: '440’a sıfırla',

  helpTitle: 'Nasıl kullanılır',
  helpStep1Title: 'Mikrofona izin verin',
  helpStep1: '“Akort etmeye başla” düğmesine dokunun ve tarayıcı sorduğunda mikrofona izin verin.',
  helpStep2Title: 'Her seferinde tek bir nota çalın',
  helpStep2: 'Tek bir dile veya tele dokunup bırakın ve tınlamasını bekleyin. Diğer notaları susturun.',
  helpStep3Title: 'Yeşile dönene kadar ayarlayın',
  helpStep3:
    'İbre ortaya gelip yeşile dönene kadar burguyu çevirin ya da kalimba dilini hafifçe kaydırın.',
  helpKalimbaTip:
    'Kalimba ipucu: kısa dil daha ince (tiz) ses verir. Notayı inceltmek (tizleştirmek) için dili köprüye doğru itin, kalınlaştırmak (pesleştirmek) için dışarı doğru çekin.',
  aboutTitle: 'Hakkında',
  version: (v: string) => `Sürüm ${v}`,
  build: (b: string) => `Derleme ${b}`,
  aboutPrivacy:
    'Gizlilik: Perde algılamanın tamamı cihazınızda yapılır. Ses asla kaydedilmez, saklanmaz ya da bir yere gönderilmez.',
  aboutOffline: 'Bir kez yüklendikten sonra çevrimdışı çalışır. Ana ekranınıza ekleyebilirsiniz.',

  errorTitle: {
    'permission-denied': 'Mikrofon erişimi engellendi',
    'no-microphone': 'Mikrofon bulunamadı',
    'insecure-context': 'Bu sayfa güvenli bağlantı gerektiriyor',
    unsupported: 'Bu tarayıcı akort aletini çalıştıramıyor',
    'mic-busy': 'Mikrofon şu anda kullanımda',
    unknown: 'Bir sorun oluştu',
  },
  errorBody: {
    'permission-denied':
      'Tunely’nin enstrümanınızı duyabilmesi için mikrofona ihtiyacı var. Yeniden izin vermek için adres çubuğunun yanındaki kilit ya da ayarlar simgesine dokunun, Mikrofon ayarını “İzin ver” olarak değiştirin ve tekrar deneyin.',
    'no-microphone':
      'Bir mikrofon ya da mikrofonlu kulaklık bağlayın ve başka bir uygulamanın onu kullanmadığından emin olun. Ardından tekrar deneyin.',
    'insecure-context':
      'Tarayıcılar mikrofona yalnızca güvenli (https://) sayfalarda izin verir. Tunely’yi https:// ile başlayan adresinden açın.',
    unsupported:
      'Lütfen Tunely’yi Chrome, Firefox, Safari ya da Edge’in güncel bir sürümüyle açın.',
    'mic-busy':
      'Mikrofonu başka bir uygulama (örneğin bir arama, görüntülü toplantı ya da ses kaydedici) kullanıyor. O uygulamayı kapatıp tekrar deneyin.',
    unknown: 'Mikrofon başlatılamadı. Lütfen tekrar deneyin.',
  },
  errorIosHint: 'iPhone/iPad’de: Ayarlar → Safari → Mikrofon → İzin Ver yolunu izleyin, ardından sayfayı yenileyin.',
  tryAgain: 'Tekrar dene',
  reload: 'Sayfayı yenile',
};

export const DICTS: Record<Lang, Dict> = { en, tr };
