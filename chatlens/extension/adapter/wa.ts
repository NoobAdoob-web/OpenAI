// Low-level, read-only access to WhatsApp Web's own code and data.
//
// WhatsApp Web (version 2.3000 and later) loads its code as named modules
// through Meta's module loader (window.require / window.__d). We open modules
// the same way the open-source WA-JS project does, and we find what we need by
// what a module CONTAINS, not only by its name, because WhatsApp renames
// modules between versions. Several routes are tried for each piece of data,
// and the route that worked is recorded for diagnostics.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyObj = Record<string, any>;

function page(): AnyObj {
  return globalThis as unknown as AnyObj;
}

export function loaderFound(): boolean {
  const w = page();
  return typeof w.require === 'function' && typeof w.__d === 'function';
}

// Modules that change WhatsApp's behaviour when opened (from WA-JS's list):
// "WAWebMoment-<language>" switches WhatsApp's date language. Never open them.
const NEVER_OPEN = [/^WAWebMoment-/, /\.react$/, /^WAWebEmojiPanel/, /^WAWebAttachMediaFlow/];

const cache = new Map<string, AnyObj | null>();

/** Opens one WhatsApp module (read-only). Returns null if it isn't there. Never throws. */
export function openModule(id: string): AnyObj | null {
  if (cache.has(id)) return cache.get(id)!;
  if (!loaderFound() || NEVER_OPEN.some((re) => re.test(id))) return null;
  const w = page();
  let mod: any = null;
  try {
    // The protected way WhatsApp's own loader expects (same as WA-JS).
    w.ErrorGuard?.skipGuardGlobal?.(true);
    mod = typeof w.importNamespace === 'function' ? w.importNamespace(id) : null;
  } catch {
    mod = null;
  }
  if (!mod) {
    try {
      mod = w.require(id);
    } catch {
      mod = null;
    }
  }
  const out = mod && typeof mod === 'object' ? (mod as AnyObj) : null;
  if (out) cache.set(id, out);
  return out;
}

/** Every module name WhatsApp Web has defined so far. */
export function moduleIds(): string[] {
  try {
    const map = page().require('__debug')?.modulesMap;
    return map && typeof map === 'object' ? Object.keys(map).filter((id) => /^(use)?WA/.test(id)) : [];
  } catch {
    return [];
  }
}

export function moduleIdsMatching(re: RegExp): string[] {
  return moduleIds().filter((id) => re.test(id));
}

/**
 * Finds a module by what it contains. Only modules whose name matches
 * `nameFilter` are opened, so we never open WhatsApp's code wholesale.
 */
export function findModule(nameFilter: RegExp, test: (m: AnyObj) => boolean, preferred: string[] = []): { id: string; mod: AnyObj } | null {
  const ids = [...preferred, ...moduleIds().filter((id) => nameFilter.test(id) && !preferred.includes(id))];
  for (const id of ids) {
    const mod = openModule(id);
    if (!mod) continue;
    try {
      if (test(mod)) return { id, mod };
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** All models in a WhatsApp collection, whatever shape the collection has. */
export function models(coll: any): AnyObj[] {
  if (!coll) return [];
  try {
    if (typeof coll.getModelsArray === 'function') return coll.getModelsArray();
    if (Array.isArray(coll.models)) return coll.models;
    if (Array.isArray(coll._models)) return coll._models;
  } catch {
    /* fall through */
  }
  return [];
}

export function isCollection(v: any): boolean {
  return !!v && typeof v === 'object' && typeof v.getModelsArray === 'function';
}

/** Reads a field from a WhatsApp model, whichever way it is stored. */
export function attr(model: any, field: string): any {
  if (!model || typeof model !== 'object') return undefined;
  try {
    if (model[field] !== undefined) return model[field];
    if (model.attributes && model.attributes[field] !== undefined) return model.attributes[field];
    if (model[`__x_${field}`] !== undefined) return model[`__x_${field}`];
  } catch {
    /* ignore */
  }
  return undefined;
}

/** A WhatsApp ID (person, group or message key) as a string. */
export function idStr(w: any): string | undefined {
  if (!w) return undefined;
  if (typeof w === 'string') return w;
  try {
    if (typeof w._serialized === 'string') return w._serialized;
    const s = typeof w.toString === 'function' ? w.toString() : undefined;
    if (typeof s === 'string' && s && s !== '[object Object]') return s;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Field names (never values) on a model, for diagnostics. */
export function fieldNames(model: any): string[] {
  if (!model || typeof model !== 'object') return [];
  const names = new Set<string>(Object.keys(model.attributes ?? {}));
  for (const k of Object.keys(model)) if (k.startsWith('__x_')) names.add(k.slice(4));
  return [...names].sort();
}

/** WhatsApp Web build version, for the diagnostics. */
export function whatsappVersion(): string {
  const v = page().Debug?.VERSION;
  return typeof v === 'string' ? v : 'unknown';
}
