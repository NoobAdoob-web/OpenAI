// The messenger between WhatsApp Web's page and the rest of the extension.
// It forwards requests from the side panel to the page reader and carries the
// answer back. It never reads WhatsApp itself.

import { CHANNEL, WA_ORIGIN, isPageResponse, type ExtRequest, type ExtResponse, type PageRequest } from '../core/bridge';

const TIMEOUT_MS = 120_000;

export default defineContentScript({
  matches: ['https://web.whatsapp.com/*'],
  runAt: 'document_idle',
  main() {
    const pending = new Map<string, (r: ExtResponse) => void>();

    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== WA_ORIGIN) return;
      const res = event.data;
      if (!isPageResponse(res)) return;
      const done = pending.get(res.reqId);
      if (!done) return;
      pending.delete(res.reqId);
      done(res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error ?? 'failed' });
    });

    browser.runtime.onMessage.addListener((msg: ExtRequest, _sender, sendResponse) => {
      if (msg?.type !== 'chatlens-adapter' || typeof msg.fn !== 'string' || !Array.isArray(msg.args)) return;
      const reqId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(reqId);
        sendResponse({ ok: false, error: 'timed out' } satisfies ExtResponse);
      }, TIMEOUT_MS);
      pending.set(reqId, (r) => {
        clearTimeout(timer);
        sendResponse(r);
      });
      const req: PageRequest = { channel: CHANNEL, dir: 'to-page', reqId, fn: msg.fn, args: msg.args };
      window.postMessage(req, WA_ORIGIN);
      return true; // answer arrives asynchronously
    });
  },
});
