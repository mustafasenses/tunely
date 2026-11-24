import './styles/main.css';
import { createTunerEngine } from './audio/engine';
import type { TunerEngine } from './audio/types';
import { mountApp } from './ui/app';

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;

  // `?mock` / `?mock=<scenario>` swaps in a simulated engine (dev, screenshots, e2e). See ui/mock-engine.ts.
  const mock = new URLSearchParams(location.search).get('mock');
  let engine: TunerEngine;
  if (mock !== null) {
    const { createMockEngine } = await import('./ui/mock-engine');
    engine = createMockEngine(mock || 'cycle');
  } else {
    engine = createTunerEngine();
  }

  mountApp({ engine, root });
  registerServiceWorker();
}

function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const register = (): void => {
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      /* offline support unavailable — app still works online */
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
  reloadOnUpdate();
}

/**
 * A new deploy activates its service worker right away (skipWaiting + clients.claim). Reload
 * into the new version — but only while nobody is tuning (start / error screen, or paused),
 * never in the middle of a tuning session; otherwise wait until the user pauses / leaves.
 */
function reloadOnUpdate(): void {
  const sw = navigator.serviceWorker;
  // The first install also fires controllerchange (clients.claim): not an update.
  let hadController = sw.controller !== null;
  let pending = false;
  const html = document.documentElement;
  const idle = (): boolean => html.dataset.view !== 'tuner' || html.dataset.paused === 'true';
  const tryReload = (): void => {
    if (pending && idle() && document.visibilityState === 'visible') {
      pending = false;
      location.reload();
    }
  };
  sw.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    pending = true;
    tryReload();
  });
  new MutationObserver(tryReload).observe(html, { attributes: true, attributeFilter: ['data-view', 'data-paused'] });
  document.addEventListener('visibilitychange', tryReload);
}

void boot();
