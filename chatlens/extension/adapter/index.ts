// THE ONLY CODE THAT TOUCHES WHATSAPP.
// Public, read-only functions (PID section 12). Nothing here can send a
// message, press a button, or load older history (rules S1, S10).

import { getActiveChat, getGroupSnapshot, listChats } from './chats';
import { allNotes } from './diagnostics';
import { measureCoverage, readLocalMessages } from './messages';
import { getPollVotes, listPolls } from './polls';
import { getStatus, runSelfTest } from './selftest';
import { ADAPTER_VERSION } from './version';
import { collections, loaderKind, moduleNames, whatsappVersion } from './wa';

/** Facts about the reading code itself. Never names, numbers or chat content. */
function getDiagnostics() {
  const names = moduleNames();
  return {
    adapterVersion: ADAPTER_VERSION,
    whatsappVersion: whatsappVersion() ?? 'unknown',
    loader: loaderKind(),
    moduleCount: names.length,
    collections: Object.keys(collections() ?? {}).sort(),
    pollModules: names.filter((n) => /^WAWeb.*Poll/i.test(n)).slice(0, 60),
    notes: allNotes(),
  };
}

export const adapter = {
  getStatus,
  getActiveChat,
  getGroupSnapshot,
  listPolls,
  getPollVotes,
  listChats,
  readLocalMessages,
  measureCoverage,
  runSelfTest,
  getDiagnostics,
};

export type AdapterApi = typeof adapter;
export type AdapterFn = keyof AdapterApi;
export const ADAPTER_FNS = Object.keys(adapter) as AdapterFn[];
