import { describe, expect, it } from 'vitest';
import { IdResolver } from '../core/ids';
import { currentVotes } from '../core/votes';

describe('currentVotes: current state only (PID section 7)', () => {
  it('keeps only the latest vote of someone who changed their vote', () => {
    const v = currentVotes(
      [
        { sender: '919800000001@c.us', selectedOptionIds: ['1'], timestampMs: 100 },
        { sender: '919800000001@c.us', selectedOptionIds: ['2'], timestampMs: 200 },
      ],
      new IdResolver(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.optionIds).toEqual(['2']);
  });
  it('drops someone who removed their vote', () => {
    const v = currentVotes(
      [
        { sender: '919800000001@c.us', selectedOptionIds: ['1'], timestampMs: 100 },
        { sender: '919800000001@c.us', selectedOptionIds: [], timestampMs: 200 },
      ],
      new IdResolver(),
    );
    expect(v).toHaveLength(0);
  });
  it('treats a privacy-ID vote and a phone-ID vote from the same person as one voter', () => {
    const r = new IdResolver();
    r.link('7700001@lid', '919800000001@c.us');
    const v = currentVotes(
      [
        { sender: '7700001@lid', selectedOptionIds: ['1'], timestampMs: 300 },
        { sender: '919800000001@c.us', selectedOptionIds: ['2'], timestampMs: 100 },
      ],
      r,
    );
    expect(v).toEqual([
      { voterId: '919800000001@c.us', voterRawIds: ['7700001@lid', '919800000001@c.us'], optionIds: ['1'], votedAt: 300 },
    ]);
  });
  it('removes duplicate options and handles missing timestamps', () => {
    const v = currentVotes([{ sender: '919800000002@c.us', selectedOptionIds: ['1', '1', '3'] }], new IdResolver());
    expect(v[0]!.optionIds).toEqual(['1', '3']);
  });
});
