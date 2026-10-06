// Runs inside WhatsApp Web's own page (Chrome's MAIN world), because that is
// the only place WhatsApp Web's data can be read. It answers requests from
// the content script and does nothing on its own (rule S2).

import { ADAPTER_FNS, adapter, type AdapterFn } from '../adapter';
import { CHANNEL, WA_ORIGIN, isPageRequest, type PageResponse } from '../core/bridge';

export default defineContentScript({
  matches: ['https://web.whatsapp.com/*'],
  world: 'MAIN',
  runAt: 'document_idle',
  main() {
    window.addEventListener('message', async (event) => {
      if (event.source !== window || event.origin !== WA_ORIGIN) return;
      const req = event.data;
      if (!isPageRequest(req)) return;
      const reply = (r: Omit<PageResponse, 'channel' | 'dir' | 'reqId'>) =>
        window.postMessage({ channel: CHANNEL, dir: 'to-ext', reqId: req.reqId, ...r } satisfies PageResponse, WA_ORIGIN);

      if (!ADAPTER_FNS.includes(req.fn as AdapterFn)) return reply({ ok: false, error: 'unknown function' });
      try {
        const fn = adapter[req.fn as AdapterFn] as (...a: unknown[]) => unknown;
        const result = await fn(...req.args);
        // Plain JSON only crosses the boundary.
        reply({ ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
      } catch (e) {
        reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  },
});
