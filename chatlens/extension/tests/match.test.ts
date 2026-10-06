import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { balances, matchPoll } from '../core/match';
import type { GroupSnapshot, Member, Poll, Vote } from '../core/types';

interface Fixture {
  description: string;
  snapshot: GroupSnapshot;
  poll: Poll;
  votes: Vote[];
  expect: {
    ok: boolean;
    reason?: string;
    summary?: { members: number; voted: number; notVoted: number; votedLeft: number };
    notVoted?: string[];
    notVotedIds?: string[];
    votedLeft?: string[];
    votedByOption?: Record<string, string[]>;
  };
}

const dir = join(__dirname, 'fixtures', 'polls');
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, ...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture) }));

const names = (ms: { displayName: string }[]) => ms.map((m) => m.displayName).sort();

describe('matchPoll: every poll edge case in PID section 7', () => {
  it('has fixtures', () => expect(fixtures.length).toBeGreaterThanOrEqual(15));

  for (const fx of fixtures) {
    it(`${fx.file}: ${fx.description}`, () => {
      const r = matchPoll(fx.snapshot, fx.poll, fx.votes);
      expect(r.ok).toBe(fx.expect.ok);
      if (!r.ok) {
        expect(r.reason).toBe(fx.expect.reason);
        expect(r.userMessage.length).toBeGreaterThan(20);
        return;
      }
      if (fx.expect.summary) expect(r.summary).toEqual(fx.expect.summary);
      if (fx.expect.notVoted) expect(names(r.notVoted)).toEqual(fx.expect.notVoted);
      if (fx.expect.notVotedIds) expect(r.notVoted.map((m) => m.id).sort()).toEqual(fx.expect.notVotedIds);
      if (fx.expect.votedLeft) expect(names(r.votedLeft)).toEqual(fx.expect.votedLeft);
      if (fx.expect.votedByOption) {
        for (const [opt, who] of Object.entries(fx.expect.votedByOption)) expect(names(r.votedByOption[opt] ?? [])).toEqual(who);
      }
      // A4 always holds on a successful result.
      const voters = new Set(fx.votes.map((v) => v.voterId)).size;
      expect(r.summary.members).toBe(r.summary.voted + r.summary.notVoted);
      expect(voters).toBe(r.summary.voted + r.summary.votedLeft);
    });
  }
});

describe('matchPoll: rules that need no fixture', () => {
  const fx = fixtures.find((f) => f.file === 'basic-small.json')!;

  it('never lets display filters change the result (hide "You" is applied later)', () => {
    const r = matchPoll(fx.snapshot, fx.poll, fx.votes);
    expect(r.ok && r.notVoted.some((m: Member) => m.isMe)).toBe(false);
    expect(r.ok && Object.values(r.votedByOption).flat().some((m) => m.isMe)).toBe(true);
  });

  it('is pure: same input, same output, input untouched', () => {
    const before = JSON.stringify(fx);
    expect(matchPoll(fx.snapshot, fx.poll, fx.votes)).toEqual(matchPoll(fx.snapshot, fx.poll, fx.votes));
    expect(JSON.stringify(fx)).toBe(before);
  });

  it('names a person who left by their ID when no name is known', () => {
    const v: Vote = { voterId: '919800000099@c.us', voterRawIds: ['919800000099@c.us'], optionIds: ['1'] };
    const r = matchPoll(fx.snapshot, { ...fx.poll, reportedVoterCount: 4 }, [...fx.votes, v]);
    expect(r.ok && r.votedLeft[0]?.displayName).toBe('919800000099@c.us');
  });

  it('skips non-person IDs when deciding whether a voter who left can be compared', () => {
    const v: Vote = { voterId: '919800000099@c.us', voterRawIds: ['legacy-id', '919800000099@c.us'], optionIds: ['1'] };
    const r = matchPoll(fx.snapshot, { ...fx.poll, reportedVoterCount: 4 }, [...fx.votes, v]);
    expect(r.ok && r.summary.votedLeft).toBe(1);
  });

  it('ignores a voter who left when building the per-option lists', () => {
    const v: Vote = { voterId: '919800000099@c.us', voterRawIds: ['919800000099@c.us'], optionIds: ['2'] };
    const r = matchPoll(fx.snapshot, { ...fx.poll, reportedVoterCount: 4 }, [...fx.votes, v]);
    expect(r.ok && names(r.votedByOption['2'] ?? [])).toEqual(['Gaurav']);
  });
});

describe('balances (A4)', () => {
  it('accepts numbers that add up', () => {
    expect(balances({ members: 38, votedInGroup: 30, notVoted: 8, voters: 31, votedLeft: 1 })).toBe(true);
  });
  it('rejects members that do not add up', () => {
    expect(balances({ members: 38, votedInGroup: 30, notVoted: 7, voters: 30, votedLeft: 0 })).toBe(false);
  });
  it('rejects voters that do not add up', () => {
    expect(balances({ members: 38, votedInGroup: 30, notVoted: 8, voters: 32, votedLeft: 1 })).toBe(false);
  });
});
