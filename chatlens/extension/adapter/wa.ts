// Low-level access to WhatsApp Web's own data (PID section 12, "Reading approach").
// WhatsApp Web loads its code as named modules (for example "WAWebCollections").
// We look those modules up and read the data models they hold. Everything here
// is read-only. This is the file most likely to need fixing after a WhatsApp update.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyObj = Record<string, any>;

type Loader = { kind: 'meta'; require: (name: string) => any } | { kind: 'none' };

function pageWindow(): AnyObj {
  return globalThis as unknown as AnyObj;
}

function loader(): Loader {
  const w = pageWindow();
  if (typeof w.require === 'function' && typeof w.__d === 'function') {
    return { kind: 'meta', require: w.require as (name: string) => any };
  }
  return { kind: 'none' };
}

export function loaderKind(): Loader['kind'] {
  return loader().kind;
}

const cache = new Map<string, AnyObj>();

/** Returns a WhatsApp module's exports, or undefined if it isn't there. Never throws. */
export function getModule(name: string): AnyObj | undefined {
  const hit = cache.get(name);
  if (hit) return hit;
  const l = loader();
  if (l.kind !== 'meta') return undefined;
  let mod: AnyObj | undefined;
  try {
    const ns = pageWindow().importNamespace;
    mod = typeof ns === 'function' ? ns(name) : undefined;
  } catch {
    mod = undefined;
  }
  if (!mod) {
    try {
      mod = l.require(name);
    } catch {
      mod = undefined;
    }
  }
  if (mod && typeof mod === 'object') cache.set(name, mod);
  return mod ?? undefined;
}

/** Names of every module WhatsApp Web has defined (for discovery and diagnostics). */
export function moduleNames(): string[] {
  const dbg = getModule('__debug');
  const map = dbg?.modulesMap;
  return map && typeof map === 'object' ? Object.keys(map) : [];
}

export function collections(): AnyObj | undefined {
  return getModule('WAWebCollections');
}

export function collection(name: string): AnyObj | undefined {
  const c = collections()?.[name];
  return c && typeof c === 'object' ? c : undefined;
}

/** All models in a WhatsApp collection, whatever shape the collection has. */
export function models(coll: AnyObj | undefined): AnyObj[] {
  if (!coll) return [];
  try {
    if (typeof coll.getModelsArray === 'function') return coll.getModelsArray();
    if (Array.isArray(coll.models)) return coll.models;
    if (Array.isArray(coll._models)) return coll._models;
    if (Array.isArray(coll)) return coll;
  } catch {
    /* fall through */
  }
  return [];
}

/** Reads an attribute from a WhatsApp model, whichever way it is stored. */
export function attr(model: AnyObj | undefined, field: string): any {
  if (!model) return undefined;
  try {
    if (model[field] !== undefined) return model[field];
    if (model.attributes && model.attributes[field] !== undefined) return model.attributes[field];
    if (model[`__x_${field}`] !== undefined) return model[`__x_${field}`];
    if (typeof model.get === 'function') return model.get(field);
  } catch {
    /* ignore */
  }
  return undefined;
}

/** WhatsApp IDs are objects with a "_serialized" string; return that string. */
export function widStr(w: any): string | undefined {
  if (!w) return undefined;
  if (typeof w === 'string') return w;
  if (typeof w._serialized === 'string') return w._serialized;
  if (typeof w.toString === 'function') {
    const s = w.toString();
    if (typeof s === 'string' && s !== '[object Object]') return s;
  }
  return undefined;
}

/** Find a model in a collection by its ID string. */
export function findById(coll: AnyObj | undefined, id: string): AnyObj | undefined {
  if (!coll) return undefined;
  try {
    const direct = typeof coll.get === 'function' ? coll.get(id) : undefined;
    if (direct) return direct;
  } catch {
    /* ignore */
  }
  return models(coll).find((m) => widStr(attr(m, 'id')) === id);
}

/** The current user's IDs (phone-based and privacy ID), as far as WhatsApp exposes them. */
export function meIds(): string[] {
  const mod = getModule('WAWebUserPrefsMeUser');
  const out: string[] = [];
  for (const fn of ['getMaybeMeUser', 'getMaybeMePnUser', 'getMaybeMeLidUser']) {
    try {
      const id = widStr(typeof mod?.[fn] === 'function' ? mod[fn]() : undefined);
      if (id) out.push(id);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(out)];
}

/** WhatsApp Web build version, for the Get help message. */
export function whatsappVersion(): string | undefined {
  const w = pageWindow();
  const v = w.Debug?.VERSION ?? getModule('WAWebBuildConstants')?.VERSION_STR;
  return typeof v === 'string' ? v : undefined;
}

/** Field names (never values) on a model, for diagnostics. */
export function fieldNames(model: AnyObj | undefined): string[] {
  if (!model) return [];
  const names = new Set<string>();
  for (const k of Object.keys(model.attributes ?? {})) names.add(k);
  for (const k of Object.keys(model)) if (k.startsWith('__x_')) names.add(k.slice(4));
  return [...names].sort();
}
