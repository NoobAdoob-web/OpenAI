// Polls: listPolls and getPollVotes.
// Votes are read from two places when possible: WhatsApp Web's memory and its
// on-computer database. When both are readable, one is the "read" list and the
// other is the independent total for rule A3. When only one is readable, the
// result is marked "not independently verified" so the founder checks by hand.

import { isPersonRawId } from '../core/ids';
import type { Poll, Vote } from '../core/types';
import { currentVotes, type RawVoteRecord } from '../core/votes';
import { note } from './diagnostics';
import { buildResolver, displayNameFor, meCanonical } from './ids';
import { iterateStore, storeNames, withWaDb } from './idb';
import { attr, collection, collections, fieldNames, findById, models, widStr, type AnyObj } from './wa';

export interface PollSummary {
  id: string;
  question: string;
  creatorName: string;
  createdAt: number;
  optionCount: number;
}

export interface PollVotesResult {
  poll: Poll;
  votes: Vote[];
  voteSources: { memory: number | null; database: number | null };
  independentlyVerified: boolean;
}

function isPollMessage(msg: AnyObj): boolean {
  const type = attr(msg, 'type');
  return (typeof type === 'string' && type.startsWith('poll_creation')) || Array.isArray(attr(msg, 'pollOptions'));
}

function chatMessages(chatId: string): AnyObj[] {
  const chat = findById(collection('Chat'), chatId);
  const inChat = models(attr(chat, 'msgs'));
  if (inChat.length) return inChat;
  return models(collection('Msg')).filter((m) => widStr(attr(attr(m, 'id'), 'remote')) === chatId);
}

function senderOf(msg: AnyObj): string | undefined {
  const id = attr(msg, 'id');
  if (attr(id, 'fromMe')) return undefined; // the current user
  return widStr(attr(msg, 'author')) ?? widStr(attr(id, 'participant')) ?? widStr(attr(msg, 'from'));
}

export function listPolls(groupId: string): PollSummary[] {
  const polls = chatMessages(groupId).filter(isPollMessage);
  if (polls[0]) note('pollMessageFields', fieldNames(polls[0]).filter((f) => /poll|vote|count/i.test(f)).join(','));
  return polls
    .map((m) => {
      const sender = senderOf(m);
      return {
        id: widStr(attr(m, 'id')) ?? '',
        question: String(attr(m, 'pollName') ?? ''),
        creatorName: sender ? displayNameFor([sender]) : 'You',
        createdAt: Number(attr(m, 't') ?? 0) * 1000,
        optionCount: (attr(m, 'pollOptions') ?? []).length,
      };
    })
    .filter((p) => p.id)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function pollMessage(pollId: string): AnyObj | undefined {
  return findById(collection('Msg'), pollId);
}

/** Does a vote record belong to this poll? Compares WhatsApp's message keys. */
function belongsTo(record: AnyObj, pollMsg: AnyObj): boolean {
  const parent = attr(record, 'parentMsgKey');
  const parentStr = widStr(parent);
  const key = attr(pollMsg, 'id');
  if (parentStr && parentStr === widStr(key)) return true;
  const parentInner = typeof parent === 'object' ? attr(parent, 'id') : undefined;
  return !!parentInner && parentInner === attr(key, 'id');
}

function toRawRecord(r: AnyObj): RawVoteRecord | undefined {
  const sender = widStr(attr(r, 'sender'));
  const selected = attr(r, 'selectedOptionLocalIds');
  if (!sender || !Array.isArray(selected)) return undefined;
  return {
    sender,
    selectedOptionIds: selected.map((x: unknown) => String(x)),
    timestampMs: Number(attr(r, 'senderTimestampMs') ?? attr(r, 't') ?? 0),
  };
}

/** Votes held in WhatsApp Web's memory. null = this source isn't available. */
function memoryVoteRecords(pollMsg: AnyObj): RawVoteRecord[] | null {
  const all = collections() ?? {};
  const names = Object.keys(all).filter((k) => /poll.*vote|vote.*poll/i.test(k));
  note('memoryVoteCollections', names.join(',') || 'none');
  if (!names.length) return null;
  const out: RawVoteRecord[] = [];
  for (const n of names) {
    for (const r of models(all[n])) {
      if (!belongsTo(r, pollMsg)) continue;
      const rec = toRawRecord(r);
      if (rec) out.push(rec);
    }
  }
  return out;
}

/** Votes stored in WhatsApp Web's on-computer database. null = not available. */
async function databaseVoteRecords(pollMsg: AnyObj): Promise<RawVoteRecord[] | null> {
  const result = await withWaDb(async (db) => {
    const stores = storeNames(db).filter((s) => /poll.?vote/i.test(s));
    note('databaseVoteStores', stores.join(',') || 'none');
    if (!stores.length) return null;
    const out: RawVoteRecord[] = [];
    for (const s of stores) {
      await iterateStore(db, s, (r) => {
        if (!belongsTo(r, pollMsg)) return;
        const rec = toRawRecord(r);
        if (rec) out.push(rec);
      });
    }
    return out;
  });
  return result ?? null;
}

export async function getPollVotes(pollId: string): Promise<PollVotesResult> {
  const msg = pollMessage(pollId);
  if (!msg || !isPollMessage(msg)) throw new Error('poll not found');

  const groupId = widStr(attr(attr(msg, 'id'), 'remote'));
  if (!groupId) throw new Error('poll has no group');

  const options = (attr(msg, 'pollOptions') ?? []).map((o: AnyObj) => ({
    id: String(attr(o, 'localId')),
    label: String(attr(o, 'name') ?? ''),
  }));
  const selectable = Number(attr(msg, 'pollSelectableOptionsCount') ?? 0);

  const memory = memoryVoteRecords(msg);
  const database = await databaseVoteRecords(msg);
  if (memory === null && database === null) throw new Error('no readable source of poll votes');

  // Resolve every sender, plus everyone in the group, in one resolver (rule A2).
  const gm = attr(findById(collection('Chat'), groupId), 'groupMetadata');
  const resolver = buildResolver(models(attr(gm, 'participants')));
  for (const r of [...(memory ?? []), ...(database ?? [])]) if (isPersonRawId(r.sender)) resolver.add(r.sender);

  const memVotes = memory ? currentVotes(memory, resolver) : null;
  const dbVotes = database ? currentVotes(database, resolver) : null;

  // The read list comes from the more complete source; the other is the cross-check.
  const read = !memVotes ? dbVotes! : !dbVotes ? memVotes : dbVotes.length >= memVotes.length ? dbVotes : memVotes;
  const check = memVotes && dbVotes ? (read === dbVotes ? memVotes : dbVotes) : read;

  const me = meCanonical(resolver);
  const sender = senderOf(msg);
  const votes = read.map((v) => ({ ...v, voterName: v.voterId === me ? 'You' : displayNameFor(v.voterRawIds) }));

  const poll: Poll = {
    id: pollId,
    groupId,
    question: String(attr(msg, 'pollName') ?? ''),
    options,
    multipleChoice: selectable !== 1,
    createdAt: Number(attr(msg, 't') ?? 0) * 1000,
    creatorId: sender ? resolver.canonical(sender) : (me ?? 'me'),
    reportedVoterCount: check.length,
  };
  note('voteCountSource', memVotes && dbVotes ? 'memory-vs-database' : memVotes ? 'memory-only' : 'database-only');

  return {
    poll,
    votes,
    voteSources: { memory: memVotes?.length ?? null, database: dbVotes?.length ?? null },
    independentlyVerified: !!(memVotes && dbVotes),
  };
}
