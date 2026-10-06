// Health check (F1): run every read function on the current state and check
// the shape of what comes back. Any failure means "Paused for update".

import type { SelfTestCheck, SelfTestResult, Status } from '../core/types';
import { getActiveChat, getGroupSnapshot, listChats } from './chats';
import { readLocalMessages } from './messages';
import { listPolls } from './polls';
import { ChatInfoSchema, GroupSnapshotSchema, LocalMessageSchema, PollSummarySchema } from './schemas';
import { collection, collections, loaderKind, meIds } from './wa';

const REQUIRED_COLLECTIONS = ['Chat', 'Msg', 'Contact', 'GroupMetadata'];

export function getStatus(): Status {
  if (loaderKind() === 'none' || !collections()) return 'paused';
  if (meIds().length === 0) return 'log-in';
  return 'ready';
}

async function check(name: string, critical: boolean, fn: () => unknown | Promise<unknown>): Promise<SelfTestCheck & { critical: boolean }> {
  try {
    const note = await fn();
    return { name, ok: true, critical, note: typeof note === 'string' ? note : undefined };
  } catch (e) {
    return { name, ok: false, critical, note: e instanceof Error ? e.message : 'failed' };
  }
}

export async function runSelfTest(): Promise<SelfTestResult> {
  const checks = [
    await check("Found WhatsApp Web's code", true, () => {
      if (loaderKind() === 'none') throw new Error('module loader not found');
    }),
    await check("Found WhatsApp Web's data", true, () => {
      const missing = REQUIRED_COLLECTIONS.filter((c) => !collection(c));
      if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
    }),
    await check('Logged in', true, () => {
      if (meIds().length === 0) throw new Error('no logged-in user found');
    }),
    await check('Read chat list', true, () => {
      const chats = listChats();
      ChatInfoSchema.array().min(1).parse(chats);
      return `${chats.length} chats`;
    }),
  ];

  const active = getActiveChat();
  if (active && active.type !== 'individual') {
    checks.push(
      await check('Read members of the open group', true, () => {
        const s = GroupSnapshotSchema.parse(getGroupSnapshot(active.id));
        return `${s.members.length} members`;
      }),
      await check('Read polls in the open group', true, () => {
        const polls = PollSummarySchema.array().parse(listPolls(active.id));
        return `${polls.length} polls loaded`;
      }),
    );
  } else {
    checks.push({ name: 'Group checks', ok: true, critical: false, note: 'Open a group to test members and polls' });
  }

  if (active) {
    checks.push(
      await check('Read messages in the open chat', true, async () => {
        // Memory only: the self-test runs on every chat switch, so it must stay quick.
        const msgs = LocalMessageSchema.array().parse(await readLocalMessages([active.id], undefined, { memoryOnly: true }));
        return `${msgs.length} messages`;
      }),
    );
  }

  const ok = checks.every((c) => c.ok || !c.critical);
  return { ok, checks: checks.map(({ critical: _critical, ...c }) => c) };
}
