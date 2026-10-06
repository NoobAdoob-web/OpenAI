// The poll matching function (PID section 13).
// In plain English: make two lists, "everyone in the group" and "everyone who
// voted", check both are complete and agree with WhatsApp's own totals, then
// subtract one from the other. Any doubt returns an error, never a list.
//
// This function MUST stay pure: no WhatsApp access, no clock, no storage.
// It has 100% test coverage (tests/match.test.ts).

import { idKind, isPersonRawId, type IdKind } from './ids';
import type { CheckResult, GroupSnapshot, Member, Poll, Vote } from './types';

const MESSAGES = {
  UNRESOLVED_VOTER:
    "We couldn't match every voter to a person in this group, so we won't show a list that might be wrong. Open the group info, wait a moment, then tap Refresh.",
  MEMBER_COUNT_MISMATCH:
    "We couldn't read every member of this group yet. Open the group info so WhatsApp loads the full member list, then tap Refresh.",
  VOTE_COUNT_MISMATCH:
    "We couldn't read every vote on this poll yet. Open the poll's votes in WhatsApp, then tap Refresh.",
  BALANCE_FAILED:
    "The numbers didn't add up, so we won't show a list that might be wrong. Tap Refresh. If this keeps happening, tap Get help.",
  ADAPTER_ERROR:
    "Something in WhatsApp Web looks different from what we expect, so we've paused to avoid a wrong result. Tap Get help.",
} as const;

function fail(reason: keyof typeof MESSAGES, detail: string): CheckResult {
  return { ok: false, reason, userMessage: MESSAGES[reason], detail };
}

/** Rule A4: members = voted-in-group + not-voted, and voters = voted-in-group + voted-left. */
export function balances(n: {
  members: number;
  votedInGroup: number;
  notVoted: number;
  voters: number;
  votedLeft: number;
}): boolean {
  return n.members === n.votedInGroup + n.notVoted && n.voters === n.votedInGroup + n.votedLeft;
}

function kindsOf(rawIds: string[]): Set<IdKind> {
  return new Set(rawIds.map(idKind));
}

/**
 * Rule A2, last line of defence. A voter who is not in the member list is only
 * accepted as "voted, left the group" if we could actually have compared them:
 * there must be an ID kind (phone or privacy ID) that the voter has AND every
 * member has. Otherwise the "ex-member" may just be a current member we failed
 * to map, which would put them in the wrong list.
 */
function comparable(voterRawIds: string[], memberKinds: Set<IdKind>[]): boolean {
  for (const kind of kindsOf(voterRawIds)) {
    if (kind !== 'phone' && kind !== 'lid') continue;
    if (memberKinds.every((k) => k.has(kind))) return true;
  }
  return false;
}

export function matchPoll(snapshot: GroupSnapshot, poll: Poll, votes: Vote[]): CheckResult {
  if (poll.groupId !== snapshot.groupId) {
    return fail('ADAPTER_ERROR', 'poll belongs to a different group than the snapshot');
  }

  const optionIds = new Set(poll.options.map((o) => o.id));
  const memberById = new Map<string, Member>(snapshot.members.map((m) => [m.id, m]));
  const memberKinds = snapshot.members.map((m) => kindsOf(m.rawIds));

  // Step 2: every voter must resolve to one person (A2).
  for (const v of votes) {
    if (!v.voterRawIds.some(isPersonRawId)) {
      return fail('UNRESOLVED_VOTER', 'a voter has no usable WhatsApp ID');
    }
    if (!memberById.has(v.voterId) && !comparable(v.voterRawIds, memberKinds)) {
      return fail('UNRESOLVED_VOTER', 'a voter outside the member list could not be compared by ID type');
    }
    if (v.optionIds.some((o) => !optionIds.has(o))) {
      return fail('ADAPTER_ERROR', 'a vote points to an option that is not on the poll');
    }
  }

  // Step 3: member count must agree with WhatsApp (A3).
  if (snapshot.members.length !== snapshot.reportedMemberCount) {
    return fail(
      'MEMBER_COUNT_MISMATCH',
      `read ${snapshot.members.length} members, WhatsApp reports ${snapshot.reportedMemberCount}`,
    );
  }

  // Step 4: voter count must agree with WhatsApp (A3).
  const voterIds = new Set(votes.map((v) => v.voterId));
  if (voterIds.size !== poll.reportedVoterCount) {
    return fail('VOTE_COUNT_MISMATCH', `read ${voterIds.size} voters, WhatsApp reports ${poll.reportedVoterCount}`);
  }

  // Steps 5 to 8.
  const memberIds = new Set(snapshot.members.map((m) => m.id));
  const notVoted = snapshot.members.filter((m) => !voterIds.has(m.id));
  const votedInGroup = snapshot.members.filter((m) => voterIds.has(m.id)).length;
  const votedLeft = votes
    .filter((v) => !memberIds.has(v.voterId))
    .map((v) => ({ id: v.voterId, displayName: v.voterName ?? v.voterId }));

  const votedByOption: Record<string, Member[]> = {};
  for (const o of poll.options) votedByOption[o.id] = [];
  for (const v of votes) {
    const member = memberById.get(v.voterId);
    if (!member) continue;
    for (const o of v.optionIds) votedByOption[o]!.push(member); // option IDs were validated above
  }

  // Step 9: the maths must balance (A4).
  const counts = {
    members: snapshot.members.length,
    votedInGroup,
    notVoted: notVoted.length,
    voters: voterIds.size,
    votedLeft: votedLeft.length,
  };
  if (!balances(counts)) {
    return fail('BALANCE_FAILED', JSON.stringify(counts));
  }

  // Step 10. Display-only filters (hide "You", hide admins) are applied by the
  // screen after this, never here.
  return {
    ok: true,
    summary: { members: counts.members, voted: votedInGroup, notVoted: notVoted.length, votedLeft: votedLeft.length },
    notVoted,
    votedByOption,
    votedLeft,
  };
}
