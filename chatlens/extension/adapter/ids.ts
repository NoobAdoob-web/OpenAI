// Rule A2 inside WhatsApp: collect every pair of IDs WhatsApp says belong to
// the same person, and feed them to the pure IdResolver in core/ids.ts.

import { IdResolver, idKind, isPersonRawId, phoneFromRawId } from '../core/ids';
import { attr, collection, getModule, meIds, models, widStr, type AnyObj } from './wa';

const LINK_FIELDS = ['phoneNumber', 'lid', 'pnJid', 'lidJid'];

function linkFromModel(r: IdResolver, model: AnyObj): void {
  const id = widStr(attr(model, 'id'));
  if (!id || !isPersonRawId(id)) return;
  r.add(id);
  for (const f of LINK_FIELDS) {
    const other = widStr(attr(model, f));
    if (other && isPersonRawId(other)) r.link(id, other);
  }
}

/** WhatsApp's own lookup between privacy IDs and phone IDs, if it exposes one. Local only. */
function linkViaWhatsAppLookup(r: IdResolver, id: string): void {
  const api = getModule('WAWebApiContact');
  if (!api) return;
  const wid = getModule('WAWebWidFactory')?.createWid?.(id);
  if (!wid) return;
  try {
    const fn = idKind(id) === 'lid' ? api.getPhoneNumber : api.getCurrentLid;
    const other = widStr(typeof fn === 'function' ? fn(wid) : undefined);
    if (other && isPersonRawId(other)) r.link(id, other);
  } catch {
    /* lookup not available in this WhatsApp version */
  }
}

let cached: { at: number; resolver: IdResolver } | undefined;

/** Builds the resolver from contacts and the current user. Rebuilt at most once a second. */
export function buildResolver(extra: AnyObj[] = []): IdResolver {
  if (cached && Date.now() - cached.at < 1000 && extra.length === 0) return cached.resolver;
  const r = new IdResolver();
  for (const c of models(collection('Contact'))) linkFromModel(r, c);
  const me = meIds();
  for (let i = 1; i < me.length; i++) r.link(me[0]!, me[i]!);
  for (const m of extra) {
    linkFromModel(r, m);
    const id = widStr(attr(m, 'id'));
    if (id && isPersonRawId(id) && r.rawIdsOf(id).length === 1) linkViaWhatsAppLookup(r, id);
  }
  if (extra.length === 0) cached = { at: Date.now(), resolver: r };
  return r;
}

export function meCanonical(r: IdResolver): string | undefined {
  const me = meIds()[0];
  return me ? r.canonical(me) : undefined;
}

/** Name exactly as WhatsApp shows it, from WhatsApp's own data only (rule A6). */
export function displayNameFor(rawIds: string[]): string {
  const contacts = collection('Contact');
  for (const id of rawIds) {
    const c = contacts && typeof contacts.get === 'function' ? safeGet(contacts, id) : undefined;
    if (!c) continue;
    for (const f of ['formattedName', 'name', 'verifiedName']) {
      const v = attr(c, f);
      if (typeof v === 'string' && v.trim()) return v;
    }
    const push = attr(c, 'pushname');
    if (typeof push === 'string' && push.trim()) return `~ ${push}`;
  }
  for (const id of rawIds) {
    const phone = phoneFromRawId(id);
    if (phone) return phone;
  }
  return 'Unknown';
}

export function phoneFor(rawIds: string[]): string | undefined {
  for (const id of rawIds) {
    const p = phoneFromRawId(id);
    if (p) return p;
  }
  return undefined;
}

function safeGet(coll: AnyObj, id: string): AnyObj | undefined {
  try {
    return coll.get(id) ?? undefined;
  } catch {
    return undefined;
  }
}
