// The strict message format between the WhatsApp page (adapter) and the
// extension (content script). PID section 12: window.postMessage with a strict
// schema and origin checks.

export const CHANNEL = 'chatlens-v1';
export const WA_ORIGIN = 'https://web.whatsapp.com';

export interface PageRequest {
  channel: typeof CHANNEL;
  dir: 'to-page';
  reqId: string;
  fn: string;
  args: unknown[];
}

export interface PageResponse {
  channel: typeof CHANNEL;
  dir: 'to-ext';
  reqId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** What the side panel sends to the content script. */
export interface ExtRequest {
  type: 'chatlens-adapter';
  fn: string;
  args: unknown[];
}

export type ExtResponse = { ok: true; result: unknown } | { ok: false; error: string };

export function isPageRequest(d: unknown): d is PageRequest {
  const r = d as PageRequest;
  return !!r && r.channel === CHANNEL && r.dir === 'to-page' && typeof r.reqId === 'string' && typeof r.fn === 'string' && Array.isArray(r.args);
}

export function isPageResponse(d: unknown): d is PageResponse {
  const r = d as PageResponse;
  return !!r && r.channel === CHANNEL && r.dir === 'to-ext' && typeof r.reqId === 'string' && typeof r.ok === 'boolean';
}
