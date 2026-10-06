// Turns raw poll-vote records into current votes (one per person).
// WhatsApp can keep several records for the same voter (they changed their
// vote, or removed it). Only the latest record counts, and a record with no
// options selected means the vote was removed (PID section 7: current state only).

import type { IdResolver } from './ids';
import type { Vote } from './types';

export interface RawVoteRecord {
  sender: string;
  selectedOptionIds: string[];
  timestampMs?: number;
}

export function currentVotes(records: RawVoteRecord[], resolver: IdResolver): Vote[] {
  const latest = new Map<string, RawVoteRecord>();
  for (const r of records) {
    const key = resolver.canonical(r.sender);
    const prev = latest.get(key);
    if (!prev || (r.timestampMs ?? 0) >= (prev.timestampMs ?? 0)) latest.set(key, r);
  }
  const votes: Vote[] = [];
  for (const [voterId, r] of latest) {
    if (r.selectedOptionIds.length === 0) continue;
    votes.push({
      voterId,
      voterRawIds: resolver.rawIdsOf(r.sender),
      optionIds: [...new Set(r.selectedOptionIds)],
      votedAt: r.timestampMs,
    });
  }
  return votes;
}
