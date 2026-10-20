// Everything the poll check needs from WhatsApp Web, and nothing else.
// Read-only. Never sends, never clicks, never loads older messages.

import { IdResolver, idKind, isPersonRawId, phoneFromRawId } from '../core/ids';
import type { GroupSnapshot, Member, Poll, Vote } from '../core/types';
import { currentVotes, type RawVoteRecord } from '../core/votes';
import { note } from './diagnostics';
import { iterateStore, storeNames, withWaDb } from './idb';
import { attr, fieldNames, findModule, idStr, isCollection, loaderFound, moduleIdsMatching, models, openModule, type AnyObj } from './wa';

// ---------------------------------------------------------------------------
// Finding WhatsApp's data
// ---------------------------------------------------------------------------

function collectionIn(mod: AnyObj | null, test: (c: AnyObj) => boolean): AnyObj | null {
  if (!mod) return null;
  const candidates = [mod.default, ...Object.values(mod)];
  for (const v of candidates) {
    try {
      if (isCollection(v) && test(v)) return v;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const looksLikeChats = (c: AnyObj) =>
  models(c).some((m) => /@(g\.us|c\.us|lid)$/.test(idStr(attr(m, 'id')) ?? '') && attr(m, 'msgs') !== undefined);

let chatStoreCache: AnyObj | null = null;

/** WhatsApp's list of chats. Three routes, tried in order. */
export function chatStore(): AnyObj | null {
  if (chatStoreCache && models(chatStoreCache).length) return chatStoreCache;
  // Route 1: the module many tools have used ("WAWebCollections").
  const legacy = openModule('WAWebCollections')?.Chat;
  if (isCollection(legacy) && looksLikeChats(legacy)) {
    note('chatsRoute', 'WAWebCollections');
    return (chatStoreCache = legacy);
  }
  // Route 2: a chat collection module, found by name and checked by content.
  // Route 3: any collection module whose content looks like a chat list.
  for (const [route, filter] of [
    ['chat-collection-module', /^WAWebChat.*Collection/],
    ['any-collection-module', /Collection/],
  ] as const) {
    const found = findModule(filter, (m) => !!collectionIn(m, looksLikeChats));
    if (found) {
      note('chatsRoute', `${route}:${found.id}`);
      return (chatStoreCache = collectionIn(found.mod, looksLikeChats));
    }
  }
  note('chatsRoute', 'not found');
  return null;
}

/** The current user's IDs (phone-based and privacy ID). */
export function meIds(): string[] {
  const found =
    (openModule('WAWebUserPrefsMeUser') && { id: 'WAWebUserPrefsMeUser', mod: openModule('WAWebUserPrefsMeUser')! }) ||
    findModule(/UserPrefs|MeUser/, (m) => typeof m.getMaybeMeUser === 'function' || typeof m.getMaybeMePnUser === 'function');
  if (!found) {
    note('meRoute', 'not found');
    return [];
  }
  note('meRoute', found.id);
  const out: string[] = [];
  for (const fn of ['getMaybeMeUser', 'getMaybeMePnUser', 'getMaybeMeLidUser', 'getMeLidUserOrThrow']) {
    try {
      const id = idStr(typeof found.mod[fn] === 'function' ? found.mod[fn]() : undefined);
      if (id && isPersonRawId(id)) out.push(id);
    } catch {
      /* not available in this version */
    }
  }
  return [...new Set(out)];
}

function activeChat(): AnyObj | null {
  const store = chatStore();
  if (!store) return null;
  try {
    if (typeof store.findFirst === 'function') {
      const a = store.findFirst((c: AnyObj) => !!attr(c, 'active'));
      if (a) return a;
    }
  } catch {
    /* fall back below */
  }
  return models(store).find((c) => !!attr(c, 'active')) ?? null;
}

function groupMetadata(chat: AnyObj): AnyObj | null {
  return attr(chat, 'groupMetadata') ?? null;
}

// ---------------------------------------------------------------------------
// Names (rule A6: exactly as WhatsApp shows them, never guessed)
// ---------------------------------------------------------------------------

function nameFromContact(c: AnyObj | null | undefined): string | undefined {
  if (!c) return undefined;
  for (const f of ['formattedName', 'name', 'verifiedName', 'displayName']) {
    const v = attr(c, f);
    if (typeof v === 'string' && v.trim()) return v;
  }
  const push = attr(c, 'pushname') ?? attr(c, 'notifyName');
  if (typeof push === 'string' && push.trim()) return `~ ${push}`;
  return undefined;
}

let contactStoreCache: AnyObj | null | undefined;
function contactStore(): AnyObj | null {
  if (contactStoreCache !== undefined) return contactStoreCache;
  const looksLikeContacts = (c: AnyObj) => models(c).some((m) => attr(m, 'isMe') !== undefined && attr(m, 'msgs') === undefined);
  const legacy = openModule('WAWebCollections')?.Contact;
  if (isCollection(legacy)) return (contactStoreCache = legacy);
  const found = findModule(/^WAWebContact.*Collection/, (m) => !!collectionIn(m, looksLikeContacts));
  return (contactStoreCache = found ? collectionIn(found.mod, looksLikeContacts) : null);
}

function contactFor(rawId: string): AnyObj | null {
  const store = contactStore();
  if (!store) return null;
  try {
    return store.get?.(rawId) ?? models(store).find((m) => idStr(attr(m, 'id')) === rawId) ?? null;
  } catch {
    return null;
  }
}

function nameFor(rawIds: string[], contact?: AnyObj | null): string {
  const direct = nameFromContact(contact);
  if (direct) return direct;
  for (const id of rawIds) {
    const n = nameFromContact(contactFor(id));
    if (n) return n;
  }
  for (const id of rawIds) {
    const p = phoneFromRawId(id);
    if (p) return p;
  }
  return 'Name hidden by WhatsApp';
}

// ---------------------------------------------------------------------------
// Rule A2: one person, one ID
// ---------------------------------------------------------------------------

/** Links privacy IDs and phone IDs using WhatsApp's own local lookups. */
function linkViaWhatsApp(r: IdResolver, ids: { raw: string; wid: unknown }[]): void {
  const lid = findModule(/Lid|Contact/, (m) => typeof m.getCurrentLid === 'function');
  const pn = findModule(/Lid|Contact/, (m) => typeof m.getPnForLid === 'function' || typeof m.getPhoneNumber === 'function');
  note('idLookupRoute', `lid:${lid?.id ?? 'none'} pn:${pn?.id ?? 'none'}`);
  for (const { raw, wid } of ids) {
    try {
      const other =
        idKind(raw) === 'lid'
          ? idStr(pn?.mod.getPnForLid?.(wid) ?? pn?.mod.getPhoneNumber?.(wid))
          : idStr(lid?.mod.getCurrentLid?.(wid));
      if (other && isPersonRawId(other)) r.link(raw, other);
    } catch {
      /* lookup not possible for this ID */
    }
  }
}

function linkFromContact(r: IdResolver, raw: string, contact: AnyObj | null | undefined): void {
  for (const f of ['phoneNumber', 'lid']) {
    const other = idStr(attr(contact, f));
    if (other && isPersonRawId(other)) r.link(raw, other);
  }
}

// ---------------------------------------------------------------------------
// Public: state of the open group, and the poll check
// ---------------------------------------------------------------------------

export interface Step {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface PollSummary {
  id: string;
  question: string;
  createdAt: number;
  options: number;
}

export interface GroupState {
  steps: Step[];
  group?: { id: string; name: string };
  polls: PollSummary[];
}

/**
 * A poll itself, not a vote. WhatsApp stores every vote as its own message too
 * ("poll_update", with pollUpdateParentKey pointing at the poll); those must
 * never be listed as polls.
 */
function isPollMsg(m: AnyObj): boolean {
  const type = attr(m, 'type');
  if (typeof type !== 'string' || !type.startsWith('poll_creation')) return false;
  if (attr(m, 'pollUpdateParentKey')) return false;
  const options = attr(m, 'pollOptions');
  return Array.isArray(options) && options.length > 0;
}

function pollMessages(chat: AnyObj): AnyObj[] {
  return models(attr(chat, 'msgs')).filter(isPollMsg);
}

function groupName(chat: AnyObj): string {
  const n = attr(chat, 'formattedTitle') ?? attr(groupMetadata(chat), 'subject') ?? attr(chat, 'name');
  return typeof n === 'string' && n ? n : 'This group';
}

/** One call that tells the panel exactly where things stand, step by step. */
export function getGroupState(): GroupState {
  const steps: Step[] = [];
  const stop = (label: string, detail: string): GroupState => {
    steps.push({ label, ok: false, detail });
    return { steps, polls: [] };
  };

  if (!loaderFound()) return stop("Found WhatsApp Web's code", 'WhatsApp Web is still loading, or it changed. Wait a few seconds and tap Refresh.');
  steps.push({ label: "Found WhatsApp Web's code", ok: true });

  if (meIds().length === 0) return stop('Logged in', 'Log in to WhatsApp Web, wait until your chats appear, then tap Refresh.');
  steps.push({ label: 'Logged in', ok: true });

  if (!chatStore()) return stop('Found your chats', "Couldn't find your chat list inside WhatsApp Web. Tap Copy details for Claude and send them.");
  steps.push({ label: 'Found your chats', ok: true });

  const chat = activeChat();
  const chatId = idStr(attr(chat, 'id'));
  if (!chat || !chatId) return stop('A group is open', 'Click a group in WhatsApp Web to open it.');
  if (!chatId.endsWith('@g.us')) return stop('A group is open', 'The open chat is not a group. Open a group that has a poll.');
  const gm = groupMetadata(chat);
  steps.push({ label: 'A group is open', ok: true, detail: groupName(chat) });

  const participants = models(attr(gm, 'participants'));
  note('memberIdKinds', kindCounts(participants.map((p) => idStr(attr(p, 'id')) ?? '')));
  if (participants.length === 0) {
    steps.push({ label: 'Read group members', ok: false, detail: 'Tap the group name at the top of the chat so WhatsApp loads the member list, then tap Refresh.' });
    return { steps, group: { id: chatId, name: groupName(chat) }, polls: [] };
  }
  steps.push({ label: 'Read group members', ok: true, detail: `${participants.length} members` });

  const polls = pollMessages(chat);
  if (polls[0]) note('pollMsgFields', fieldNames(polls[0]).filter((f) => /poll|vote/i.test(f)).join(','));
  steps.push({
    label: 'Found polls in this chat',
    ok: polls.length > 0,
    detail: polls.length ? `${polls.length}` : 'No poll is loaded. Scroll up in the chat until you can see your poll, then tap Refresh.',
  });

  return {
    steps,
    group: { id: chatId, name: groupName(chat) },
    polls: polls
      .map((m) => ({
        id: idStr(attr(m, 'id')) ?? '',
        question: String(attr(m, 'pollName') ?? ''),
        createdAt: Number(attr(m, 't') ?? 0) * 1000,
        options: (attr(m, 'pollOptions') ?? []).length,
      }))
      .filter((p) => p.id)
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

function kindCounts(ids: string[]): string {
  const c: Record<string, number> = {};
  for (const id of ids) c[idKind(id)] = (c[idKind(id)] ?? 0) + 1;
  return Object.entries(c)
    .map(([k, n]) => `${k}:${n}`)
    .join(' ');
}

// ---- votes ----

/** Describes a value's structure (field names and types, never values) for diagnostics. */
function shapeOf(v: unknown, depth = 2): unknown {
  if (Array.isArray(v)) return v.length ? [`${v.length} items`, shapeOf(v[0], depth - 1)] : '[]';
  if (v && typeof v === 'object') {
    if (depth <= 0) return 'object';
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).slice(0, 30)) o[k] = shapeOf((v as AnyObj)[k], depth - 1);
    return o;
  }
  return v === null ? 'null' : typeof v;
}

class UnreadableVote extends Error {}

function toRecord(r: AnyObj): RawVoteRecord & { wid: unknown } {
  const senderWid = attr(r, 'sender');
  const sender = idStr(senderWid) ?? '';
  const selected = attr(r, 'selectedOptionLocalIds');
  // An empty list means the person removed their vote. A missing list means we
  // can't read the vote at all: that must stop the check, never count as "not voted".
  if (!Array.isArray(selected)) throw new UnreadableVote();
  return {
    sender,
    wid: senderWid,
    selectedOptionIds: selected.map((x: unknown) => String(x)),
    timestampMs: Number(attr(r, 'senderTimestampMs') ?? 0),
  };
}

/** WhatsApp's own converter from a database row to a vote, if it has one. */
function voteConverter(): ((row: AnyObj) => AnyObj) | null {
  const found = findModule(/Poll|Vote/i, (m) => typeof m.voteFromDbRow === 'function');
  note('voteConverterRoute', found?.id ?? 'not found');
  return found ? (row) => found.mod.voteFromDbRow(row) : null;
}

/** Names of WhatsApp's poll modules and their functions (no user data), to help fix the next version. */
function pollModuleMap(): string {
  return moduleIdsMatching(/Poll.*Vote|Vote.*Poll|PollsVote|PollVote/i)
    .slice(0, 25)
    .map((id) => {
      const m = openModule(id);
      const fns = m ? Object.keys(m).filter((k) => typeof m[k] === 'function').slice(0, 12) : [];
      return `${id}[${fns.join(',')}]`;
    })
    .join(' ');
}

/** Route A: WhatsApp Web's own "get votes" function. null = not available. */
async function votesFromWhatsApp(pollMsg: AnyObj): Promise<AnyObj[] | null> {
  const found =
    findModule(/Poll|Vote/i, (m) => typeof m.getVotes === 'function' && (typeof m.upsertVotes === 'function' || typeof m.upsertVotesDb === 'function' || typeof m.getVote === 'function')) ??
    findModule(/Poll|Vote/i, (m) => typeof m.getVotes === 'function');
  note('votesFunctionRoute', found?.id ?? 'not found');
  if (!found) note('pollModules', pollModuleMap());
  if (!found) return null;
  try {
    const rows = await found.mod.getVotes([attr(pollMsg, 'id')]);
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    note('votesFunctionError', e instanceof Error ? e.name : 'error');
    return null;
  }
}

/** Route B: the "poll-votes" table in WhatsApp Web's database on this computer. null = not available. */
async function votesFromDatabase(pollKey: string): Promise<AnyObj[] | null> {
  const rows = await withWaDb(async (db) => {
    const stores = storeNames(db).filter((s) => /poll.?vote/i.test(s));
    note('votesDatabaseStores', stores.join(',') || 'none');
    if (!stores.length) return null;
    const out: AnyObj[] = [];
    for (const s of stores) {
      await iterateStore(db, s, (row) => {
        if (idStr(attr(row, 'parentMsgKey')) === pollKey) out.push(row);
      });
    }
    return out;
  });
  return rows ?? null;
}

export interface PollCheckData {
  snapshot: GroupSnapshot;
  poll: Poll;
  votes: Vote[];
  sources: { whatsapp: number | null; database: number | null };
  crossChecked: boolean;
}

export async function readPoll(groupId: string, pollId: string): Promise<PollCheckData> {
  const chat = activeChat();
  if (!chat || idStr(attr(chat, 'id')) !== groupId) throw new Error('The group changed. Tap Refresh.');
  const msg = pollMessages(chat).find((m) => idStr(attr(m, 'id')) === pollId);
  if (!msg) throw new Error("This poll isn't loaded any more. Scroll up to it, then tap Refresh.");
  const gm = groupMetadata(chat);
  const allParticipants = models(attr(gm, 'participants'));
  // "Stale" entries are out-of-date members WhatsApp still keeps in the list.
  const staleCount = allParticipants.filter((p) => attr(p, 'stale') === true).length;
  const sizeValue = attr(gm, 'size');
  note('memberList', `listed:${allParticipants.length} stale:${staleCount} whatsappSize:${typeof sizeValue === 'number' ? sizeValue : 'none'}`);
  // Leave stale entries out only when that makes the list agree exactly with WhatsApp's own total.
  const dropStale = staleCount > 0 && typeof sizeValue === 'number' && allParticipants.length - staleCount === sizeValue;
  const participants = dropStale ? allParticipants.filter((p) => attr(p, 'stale') !== true) : allParticipants;
  const past = models(attr(gm, 'pastParticipants'));
  note('pollSnapshotShape', JSON.stringify(shapeOf(attr(msg, 'pollVotesSnapshot'), 3)));

  // Votes, from every route that works. A route whose votes can't be fully read is dropped, never half-used.
  const [fromWa, fromDbRaw] = await Promise.all([votesFromWhatsApp(msg), votesFromDatabase(pollId)]);
  if (fromDbRaw?.[0]) note('voteRowShape', JSON.stringify(shapeOf(fromDbRaw[0])));
  const convert = fromDbRaw?.length ? voteConverter() : null;
  let fromDb = fromDbRaw;
  if (fromDbRaw && convert) {
    try {
      fromDb = fromDbRaw.map(convert);
      if (fromDb[0]) note('convertedVoteShape', JSON.stringify(shapeOf(fromDb[0])));
    } catch (e) {
      note('voteConverterError', e instanceof Error ? e.name : 'error');
      fromDb = null;
    }
  }
  const readable = (rows: AnyObj[] | null, source: string) => {
    if (!rows) return null;
    try {
      return rows.map(toRecord);
    } catch (e) {
      if (!(e instanceof UnreadableVote)) throw e;
      note(`${source}VotesUnreadable`, 'the chosen option could not be read');
      return null;
    }
  };
  const waRecords = readable(fromWa, 'whatsapp');
  const dbRecords = readable(fromDb, 'database');
  if (waRecords === null && dbRecords === null) {
    throw new Error("Couldn't read the votes on this poll from WhatsApp Web. Tap Copy details for Claude and send them.");
  }
  const allRecords = [...(waRecords ?? []), ...(dbRecords ?? [])].filter((r) => isPersonRawId(r.sender));
  note('voterIdKinds', kindCounts(allRecords.map((r) => r.sender)));

  // One person, one ID (rule A2).
  const r = new IdResolver();
  const me = meIds();
  for (const id of me) r.add(id);
  for (let i = 1; i < me.length; i++) r.link(me[0]!, me[i]!);
  const people = [...participants, ...past].map((p) => ({ raw: idStr(attr(p, 'id')) ?? '', wid: attr(p, 'id'), contact: attr(p, 'contact') }));
  for (const p of people) {
    if (!isPersonRawId(p.raw)) continue;
    r.add(p.raw);
    linkFromContact(r, p.raw, p.contact);
  }
  for (const v of allRecords) r.add(v.sender);
  // Only when phone IDs and privacy IDs are mixed do we need WhatsApp's own lookup.
  const kinds = new Set([...people.map((p) => idKind(p.raw)), ...allRecords.map((v) => idKind(v.sender))].filter((k) => k === 'phone' || k === 'lid'));
  if (kinds.size > 1) linkViaWhatsApp(r, [...people.map((p) => ({ raw: p.raw, wid: p.wid })), ...allRecords.map((v) => ({ raw: v.sender, wid: v.wid }))]);

  const meCanonical = me[0] ? r.canonical(me[0]) : undefined;

  const members: Member[] = participants.map((p) => {
    const raw = idStr(attr(p, 'id')) ?? '';
    const id = r.canonical(raw);
    const rawIds = r.rawIdsOf(raw);
    const phone = rawIds.map(phoneFromRawId).find(Boolean);
    const isMe = id === meCanonical;
    return {
      id,
      rawIds,
      displayName: isMe ? 'You' : nameFor(rawIds, attr(p, 'contact')),
      phone,
      isAdmin: !!attr(p, 'isAdmin') || !!attr(p, 'isSuperAdmin'),
      isMe,
      canOpenPrivateChat: !!phone,
    };
  });

  const pastNames = new Map(people.slice(participants.length).map((p) => [r.canonical(p.raw), nameFor(r.rawIdsOf(p.raw), p.contact)]));
  const named = (votes: Vote[]) =>
    votes.map((v) => ({
      ...v,
      voterName: v.voterId === meCanonical ? 'You' : (pastNames.get(v.voterId) ?? nameFor(v.voterRawIds)),
    }));

  const waVotes = waRecords ? currentVotes(waRecords, r) : null;
  const dbVotes = dbRecords ? currentVotes(dbRecords, r) : null;
  // The fuller source is the list we show; the other one is the cross-check (rule A3).
  const shown = !waVotes ? dbVotes! : !dbVotes ? waVotes : dbVotes.length > waVotes.length ? dbVotes : waVotes;
  const other = waVotes && dbVotes ? (shown === waVotes ? dbVotes : waVotes) : shown;

  // Rule A3: the member total WhatsApp itself reports ("size"), if it has one.
  const size = attr(gm, 'size');
  const hasSize = typeof size === 'number' && size > 0;
  note('memberCountRoute', hasSize ? 'whatsapp-size' : 'participant-list');

  const sender = idStr(attr(msg, 'author')) ?? idStr(attr(attr(msg, 'id'), 'participant'));
  const selectable = Number(attr(msg, 'pollSelectableOptionsCount') ?? 0);

  return {
    snapshot: {
      groupId,
      groupName: groupName(chat),
      reportedMemberCount: hasSize ? size : participants.length,
      members,
      readAt: Date.now(),
    },
    poll: {
      id: pollId,
      groupId,
      question: String(attr(msg, 'pollName') ?? ''),
      options: (attr(msg, 'pollOptions') ?? []).map((o: AnyObj) => ({ id: String(attr(o, 'localId')), label: String(attr(o, 'name') ?? '') })),
      multipleChoice: selectable !== 1,
      createdAt: Number(attr(msg, 't') ?? 0) * 1000,
      creatorId: sender && isPersonRawId(sender) ? r.canonical(sender) : (meCanonical ?? 'me'),
      reportedVoterCount: other.length,
    },
    votes: named(shown),
    sources: { whatsapp: waVotes?.length ?? null, database: dbVotes?.length ?? null },
    crossChecked: !!(waVotes && dbVotes),
  };
}
