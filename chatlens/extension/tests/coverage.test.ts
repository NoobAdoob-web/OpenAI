import { describe, expect, it } from 'vitest';
import { CoverageCounter, describeCoverage, unavailable } from '../core/coverage';

describe('coverage report', () => {
  it('counts messages, chats, dates and readable text', () => {
    const c = new CoverageCounter();
    c.add({ chatId: 'a', timestamp: Date.UTC(2025, 2, 12, 12), shouldHaveText: true, textReadable: true });
    c.add({ chatId: 'a', timestamp: Date.UTC(2026, 9, 1, 12), shouldHaveText: true, textReadable: false });
    c.add({ chatId: 'b', timestamp: 0, shouldHaveText: false, textReadable: false });
    const r = c.report('Stored on this computer', 1234.4);
    expect(r).toMatchObject({ messages: 3, chats: 2, textMessages: 2, textReadable: 1, msElapsed: 1234, biggestChats: [2, 1] });
    const lines = describeCoverage(r);
    expect(lines[0]).toBe('Stored on this computer: 3 messages in 2 chats.');
    expect(lines[1]).toBe('Oldest message: 12 Mar 2025. Newest: 1 Oct 2026.');
    expect(lines[2]).toBe('Text is only partly readable. 1 of 2 text messages (50%).');
    expect(lines[3]).toBe('Time to read everything: 1.2 seconds.');
  });
  it('says plainly when text is scrambled', () => {
    const c = new CoverageCounter();
    c.add({ chatId: 'a', timestamp: 1, shouldHaveText: true, textReadable: false });
    expect(describeCoverage(c.report('X', 5, 'note here'))).toEqual([
      'X: 1 messages in 1 chats.',
      'Oldest message: 1 Jan 1970. Newest: 1 Jan 1970.',
      'Text is NOT readable (stored scrambled). 0 of 1 text messages (0%).',
      'Time to read everything: 5 ms.',
      'Biggest chats hold 1 messages.',
      'note here',
    ]);
  });
  it('handles an empty or missing source', () => {
    expect(describeCoverage(new CoverageCounter().report('X', 0))).toContain('No text messages found, so we could not tell whether text is readable.');
    expect(describeCoverage(unavailable('X', 'Not found.'))).toEqual(['X: not readable. Not found.']);
  });
});
