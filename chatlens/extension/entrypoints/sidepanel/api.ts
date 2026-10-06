// How the side panel talks to the WhatsApp Web tab (through the content script).

import type { AdapterApi, AdapterFn } from '../../adapter';
import type { ExtRequest, ExtResponse } from '../../core/bridge';

export class NotOnWhatsApp extends Error {}
export class NeedsReload extends Error {}

type Result<F extends AdapterFn> = Awaited<ReturnType<AdapterApi[F]>>;

export async function call<F extends AdapterFn>(fn: F, ...args: Parameters<AdapterApi[F]>): Promise<Result<F>> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('https://web.whatsapp.com/')) throw new NotOnWhatsApp();
  let res: ExtResponse | undefined;
  try {
    res = await browser.tabs.sendMessage(tab.id, { type: 'chatlens-adapter', fn, args } satisfies ExtRequest);
  } catch {
    throw new NeedsReload();
  }
  if (!res) throw new NeedsReload();
  if (!res.ok) throw new Error(res.error);
  return res.result as Result<F>;
}
