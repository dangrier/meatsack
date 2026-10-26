import { spawn } from 'node:child_process';
import { log } from './log.js';

/**
 * Pops the prompt UI in front of the human. Throttled, because a burst of
 * asks should surface one window, not ten.
 */
export function createOpener(enabled: boolean): (url: string) => void {
  let lastOpen = 0;
  const throttleMs = 3000;

  return (url: string) => {
    if (!enabled) {
      log.info(`someone needs you: ${url}`);
      return;
    }
    const now = Date.now();
    if (now - lastOpen < throttleMs) return;
    lastOpen = now;

    const [cmd, args] = commandFor(url);
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', (err) => log.warn(`could not open a browser (${err.message}): ${url}`));
      child.unref();
      log.info(`opened the prompt UI: ${url}`);
    } catch (err) {
      log.warn(`could not open a browser: ${url}`, err);
    }
  };
}

function commandFor(url: string): [string, string[]] {
  switch (process.platform) {
    case 'darwin':
      return ['open', [url]];
    case 'win32':
      return ['cmd', ['/c', 'start', '""', url]];
    default:
      return ['xdg-open', [url]];
  }
}
