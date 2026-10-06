// Local messages: readLocalMessages and the Phase 0 coverage measurement.
// Rule S10: this file NEVER scrolls or loads older history. It only reads
// what WhatsApp Web already holds on this computer.
// Rule S12: no requests to WhatsApp's servers. Memory and IndexedDB only.

import { CoverageCounter, unavailable, type CoverageSourceReport } from '../core/coverage';
import type { IdResolver } from '../core/ids';
import type { ChatType, LocalMessage } from '../core/types';
import { listChats } from './chats';
import { note } from './diagnostics';
import { buildResolver, meCanonical } from './ids';
import { iterateStore, storeNames, withWaDb } from './idb';
import { attr, collection, models, widStr, type AnyObj } from './wa';

const KIND: Record<string, LocalMessage['kind']> = {
  chat: 'text',
  image: 'image',
  video: 'video',
  gif: 'video',
  ptv: 'video',
  document: 'document',
  audio: 'audio',
  ptt: 'audio',
};

/** Only these message types carry their words in "body". For media, "body" is a thumbnail. */
const TEXT_IN_BODY = new Set(['chat']);

function textOf(type: string, m: AnyObj): string {
  const raw = TEXT_IN_BODY.has(type) ? attr(m, 'body') : attr(m, 'caption');
  return typeof raw === 'string' ? raw : '';
}

function chatIdOf(m: AnyObj): string | undefined {
  const id = attr(m, 'id');
  if (typeof id === 'string') return parseKey(id)?.remote;
  return widStr(attr(id, 'remote'));
}

/** "false_123@g.us_ABCDEF_456@c.us" → parts. */
function parseKey(key: string): { fromMe: boolean; remote: string; participant?: string } | undefined {
  const parts = key.split('_');
  if (parts.length < 3) return undefined;
  return { fromMe: parts[0] === 'true', remote: parts[1]!, participant: parts[3] };
}

function toLocal(m: AnyObj, chatTypes: Map<string, { type: ChatType; communityId?: string }>, r: IdResolver, me: string): LocalMessage | undefined {
  const idObj = attr(m, 'id');
  const id = widStr(idObj);
  const chatId = chatIdOf(m);
  if (!id || !chatId) return undefined;
  const parsed = typeof idObj === 'string' ? parseKey(idObj) : undefined;
  const fromMe = parsed ? parsed.fromMe : !!attr(idObj, 'fromMe');
  const sender = fromMe
    ? me
    : (widStr(attr(m, 'author')) ?? parsed?.participant ?? widStr(attr(idObj, 'participant')) ?? widStr(attr(m, 'from')) ?? chatId);
  const type = String(attr(m, 'type') ?? '');
  const text = textOf(type, m);
  const chat = chatTypes.get(chatId);
  const fileName = attr(m, 'filename');
  return {
    id,
    chatId,
    chatType: chat?.type ?? (chatId.endsWith('@g.us') ? 'group' : 'individual'),
    communityId: chat?.communityId,
    senderId: r.canonical(sender),
    timestamp: Number(attr(m, 't') ?? 0) * 1000,
    text,
    kind: KIND[type] ?? (type === 'chat' && /https?:\/\//i.test(text) ? 'link' : 'other'),
    fileName: typeof fileName === 'string' ? fileName : undefined,
    isEdited: !!attr(m, 'latestEditMsgKey'),
    isDeletedForEveryone: type === 'revoked',
    isViewOnce: !!attr(m, 'isViewOnce'),
  };
}

function messageStore(stores: string[]): string | undefined {
  return stores.find((s) => s === 'message') ?? stores.find((s) => /^messages?$/i.test(s));
}

/**
 * Reads messages WhatsApp Web already holds on this computer.
 * Deleted-for-everyone and view-once messages are dropped here (rule A14).
 */
export async function readLocalMessages(
  chatIds?: string[],
  sinceDate?: number,
  opts: { memoryOnly?: boolean } = {},
): Promise<LocalMessage[]> {
  const wanted = chatIds?.length ? new Set(chatIds) : undefined;
  const chatTypes = new Map(listChats().map((c) => [c.id, { type: c.type, communityId: c.communityId }]));
  const r = buildResolver();
  const me = meCanonical(r) ?? 'me';
  const out = new Map<string, LocalMessage>();

  const keep = (m: AnyObj) => {
    const chatId = chatIdOf(m);
    if (!chatId || (wanted && !wanted.has(chatId))) return;
    const lm = toLocal(m, chatTypes, r, me);
    if (!lm || lm.isDeletedForEveryone || lm.isViewOnce) return;
    if (sinceDate && lm.timestamp < sinceDate) return;
    out.set(lm.id, lm);
  };

  for (const m of models(collection('Msg'))) keep(m);
  const memoryCount = out.size;

  // The on-computer database usually holds more history than memory. Its
  // records are only used if their text is readable as plain text.
  if (opts.memoryOnly) return [...out.values()];
  await withWaDb(async (db) => {
    const store = messageStore(storeNames(db));
    if (!store) return;
    await iterateStore(db, store, (rec) => {
      const type = String(rec?.type ?? '');
      if (TEXT_IN_BODY.has(type) && typeof rec?.body !== 'string') return;
      const id = widStr(rec?.id);
      if (id && !out.has(id)) keep(rec);
    });
  });
  note('readLocalMessages', `memory=${memoryCount}, database-added=${out.size - memoryCount}`);
  return [...out.values()];
}

/** Phase 0 deliverable 4: how much history is readable. Counts only, no text kept. */
export async function measureCoverage(): Promise<{ memory: CoverageSourceReport; database: CoverageSourceReport; databaseFields: string[] }> {
  // 1. Memory: what WhatsApp Web has loaded right now.
  let t0 = performance.now();
  const mem = new CoverageCounter();
  for (const m of models(collection('Msg'))) {
    const chatId = chatIdOf(m);
    if (!chatId) continue;
    const type = String(attr(m, 'type') ?? '');
    mem.add({
      chatId,
      timestamp: Number(attr(m, 't') ?? 0) * 1000,
      shouldHaveText: type === 'chat',
      textReadable: type === 'chat' && typeof attr(m, 'body') === 'string' && attr(m, 'body').length > 0,
    });
  }
  const memory = mem.report('Loaded in WhatsApp Web right now', performance.now() - t0);

  // 2. The on-computer database: what could be searched without loading anything.
  t0 = performance.now();
  const fields = new Set<string>();
  let sampled = 0;
  let opaque = 0;
  const db = await withWaDb(async (dbh) => {
    const stores = storeNames(dbh);
    const store = messageStore(stores);
    if (!store) return unavailable('Stored on this computer', `No message store found. Stores present: ${stores.join(', ')}`);
    const counter = new CoverageCounter();
    await iterateStore(dbh, store, (rec) => {
      if (sampled < 200) {
        for (const k of Object.keys(rec ?? {})) fields.add(k);
        sampled++;
      }
      if (rec?.msgRowOpaqueData) opaque++;
      const chatId = chatIdOf(rec);
      if (!chatId) return;
      const type = String(rec?.type ?? '');
      counter.add({
        chatId,
        timestamp: Number(rec?.t ?? 0) * 1000,
        shouldHaveText: type === 'chat' || (!type && !!rec?.msgRowOpaqueData),
        textReadable: type === 'chat' && typeof rec?.body === 'string' && rec.body.length > 0,
      });
    });
    const extra = opaque ? `${opaque.toLocaleString('en-IN')} records hold their content in a scrambled (encrypted) field.` : undefined;
    return counter.report('Stored on this computer', performance.now() - t0, extra);
  });

  return {
    memory,
    database: db ?? unavailable('Stored on this computer', "WhatsApp Web's database could not be opened."),
    databaseFields: [...fields].sort(),
  };
}
