// Phase 0 coverage report: how much message history is actually readable on
// this computer. It counts only; it never keeps message text (rule P7).

export interface CoverageSourceReport {
  source: string; // plain-English name of where the messages were read from
  available: boolean;
  note?: string; // why it isn't available, or anything surprising
  messages: number;
  chats: number;
  oldestTimestamp?: number; // epoch ms
  newestTimestamp?: number; // epoch ms
  textMessages: number; // messages of a kind that should carry text
  textReadable: number; // of those, how many had readable text
  msElapsed: number;
  biggestChats: number[]; // message counts of the 5 biggest chats, no names
}

export class CoverageCounter {
  private perChat = new Map<string, number>();
  private messages = 0;
  private oldest = Infinity;
  private newest = -Infinity;
  private textMessages = 0;
  private textReadable = 0;

  add(m: { chatId: string; timestamp?: number; shouldHaveText: boolean; textReadable: boolean }): void {
    this.messages++;
    this.perChat.set(m.chatId, (this.perChat.get(m.chatId) ?? 0) + 1);
    if (m.timestamp && m.timestamp > 0) {
      this.oldest = Math.min(this.oldest, m.timestamp);
      this.newest = Math.max(this.newest, m.timestamp);
    }
    if (m.shouldHaveText) {
      this.textMessages++;
      if (m.textReadable) this.textReadable++;
    }
  }

  report(source: string, msElapsed: number, note?: string): CoverageSourceReport {
    return {
      source,
      available: true,
      note,
      messages: this.messages,
      chats: this.perChat.size,
      oldestTimestamp: Number.isFinite(this.oldest) ? this.oldest : undefined,
      newestTimestamp: Number.isFinite(this.newest) ? this.newest : undefined,
      textMessages: this.textMessages,
      textReadable: this.textReadable,
      msElapsed: Math.round(msElapsed),
      biggestChats: [...this.perChat.values()].sort((a, b) => b - a).slice(0, 5),
    };
  }
}

export function unavailable(source: string, note: string): CoverageSourceReport {
  return {
    source,
    available: false,
    note,
    messages: 0,
    chats: 0,
    textMessages: 0,
    textReadable: 0,
    msElapsed: 0,
    biggestChats: [],
  };
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-IN');
}

function fmtTime(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} seconds`;
}

/** The plain-English summary for the founder (Phase 0 deliverable 4). */
export function describeCoverage(r: CoverageSourceReport): string[] {
  if (!r.available) return [`${r.source}: not readable. ${r.note ?? ''}`.trim()];
  const lines = [
    `${r.source}: ${fmtNum(r.messages)} messages in ${fmtNum(r.chats)} chats.`,
    r.oldestTimestamp && r.newestTimestamp
      ? `Oldest message: ${fmtDate(r.oldestTimestamp)}. Newest: ${fmtDate(r.newestTimestamp)}.`
      : 'No message dates found.',
  ];
  if (r.textMessages === 0) {
    lines.push('No text messages found, so we could not tell whether text is readable.');
  } else {
    const pct = Math.round((r.textReadable / r.textMessages) * 100);
    const verdict =
      pct >= 95 ? 'Text is readable.' : pct === 0 ? 'Text is NOT readable (stored scrambled).' : 'Text is only partly readable.';
    lines.push(`${verdict} ${fmtNum(r.textReadable)} of ${fmtNum(r.textMessages)} text messages (${pct}%).`);
  }
  lines.push(`Time to read everything: ${fmtTime(r.msElapsed)}.`);
  if (r.biggestChats.length) lines.push(`Biggest chats hold ${r.biggestChats.map(fmtNum).join(', ')} messages.`);
  if (r.note) lines.push(r.note);
  return lines;
}
