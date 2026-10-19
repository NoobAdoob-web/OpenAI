// THE ONLY CODE THAT TOUCHES WHATSAPP.
// This build does one thing: the poll check. Every function here only reads.
// Nothing can send a message, press a button, or load older messages (rules S1, S10).

import { allNotes, note } from './diagnostics';
import { getGroupState, readPoll } from './poll';
import { PollCheckDataSchema } from './schemas';
import { ADAPTER_VERSION } from './version';
import { loaderFound, moduleIds, whatsappVersion } from './wa';

/** Reads the poll, then checks the shape of everything read (rule A8). */
async function checkPoll(groupId: string, pollId: string) {
  const data = await readPoll(groupId, pollId);
  const parsed = PollCheckDataSchema.safeParse(data);
  if (!parsed.success) {
    note('shapeCheckFailed', parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    throw new Error("WhatsApp Web's data looked different from what we expect, so we stopped rather than show a wrong list. Tap Copy details for Claude and send them.");
  }
  return parsed.data;
}

/** Technical facts about HOW reading worked. Never names, numbers or messages. */
function getDiagnostics() {
  return {
    adapterVersion: ADAPTER_VERSION,
    whatsappVersion: whatsappVersion(),
    loaderFound: loaderFound(),
    moduleCount: moduleIds().length,
    routes: allNotes(),
  };
}

export const adapter = { getGroupState, checkPoll, getDiagnostics };

export type AdapterApi = typeof adapter;
export type AdapterFn = keyof AdapterApi;
export const ADAPTER_FNS = Object.keys(adapter) as AdapterFn[];
export type { GroupState, PollCheckData, PollSummary, Step } from './poll';
