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
}

void boot();
