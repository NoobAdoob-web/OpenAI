// Rule A2: WhatsApp has more than one internal ID for the same person
// (a phone-based ID like 919812345678@c.us and a privacy ID like 12345@lid).
// This module merges every ID we know belongs to one person into a single
// canonical PersonId. It is pure, so it is tested with plain data.

export type IdKind = 'phone' | 'lid' | 'group' | 'other';

/** Normalise the different spellings WhatsApp uses for the same phone ID. */
export function normalizeRawId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (id.endsWith('@s.whatsapp.net')) return id.replace('@s.whatsapp.net', '@c.us');
  return id;
}

export function idKind(raw: string): IdKind {
  const id = normalizeRawId(raw);
  if (id.endsWith('@c.us')) return 'phone';
  if (id.endsWith('@lid')) return 'lid';
  if (id.endsWith('@g.us')) return 'group';
  return 'other';
}

/** A person ID is usable only if it is a well-formed phone or privacy ID. */
export function isPersonRawId(raw: string): boolean {
  const kind = idKind(raw);
  if (kind !== 'phone' && kind !== 'lid') return false;
  const user = normalizeRawId(raw).split('@')[0] ?? '';
  return /^\d+(:\d+)?$/.test(user);
}

/** Phone number as WhatsApp would show it, only for phone-based IDs (rule A6). */
export function phoneFromRawId(raw: string): string | undefined {
  if (idKind(raw) !== 'phone') return undefined;
  const user = normalizeRawId(raw).split('@')[0]?.split(':')[0];
  return user ? `+${user}` : undefined;
}

/**
 * Union-find over raw IDs. Feed it every pair of IDs WhatsApp says belong to
 * the same person; ask it for the canonical ID of any raw ID.
 * The canonical ID prefers the phone-based ID when one is known, so the same
 * person gets the same PersonId in every group and every chat (rule A1).
 */
export class IdResolver {
  private parent = new Map<string, string>();

  add(raw: string): void {
    const id = normalizeRawId(raw);
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  link(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.root(normalizeRawId(a));
    const rb = this.root(normalizeRawId(b));
    if (ra === rb) return;
    // Keep a phone ID as the root when there is one.
    if (idKind(rb) === 'phone' && idKind(ra) !== 'phone') this.parent.set(ra, rb);
    else this.parent.set(rb, ra);
  }

  private root(id: string): string {
    let cur = id;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur);
      if (next === undefined) return cur;
      cur = next;
    }
    return cur;
  }

  /** Canonical PersonId for a raw ID. Unknown IDs are their own canonical ID. */
  canonical(raw: string): string {
    const id = normalizeRawId(raw);
    return this.parent.has(id) ? this.root(id) : id;
  }

  /** Every raw ID known to belong to the same person as `raw`. */
  rawIdsOf(raw: string): string[] {
    const c = this.canonical(raw);
    const out = [...this.parent.keys()].filter((k) => this.root(k) === c);
    return out.length ? out.sort() : [normalizeRawId(raw)];
  }
}
