import { describe, expect, it } from 'vitest';
import { IdResolver, idKind, isPersonRawId, normalizeRawId, phoneFromRawId } from '../core/ids';

describe('ID helpers', () => {
  it('normalises the two spellings of a phone ID', () => {
    expect(normalizeRawId('919812345678@s.whatsapp.net')).toBe('919812345678@c.us');
    expect(normalizeRawId(' 919812345678@C.US ')).toBe('919812345678@c.us');
  });
  it('knows ID kinds', () => {
    expect(idKind('91981@c.us')).toBe('phone');
    expect(idKind('123@lid')).toBe('lid');
    expect(idKind('120363@g.us')).toBe('group');
    expect(idKind('status@broadcast')).toBe('other');
  });
  it('accepts only well-formed person IDs', () => {
    expect(isPersonRawId('919812345678@c.us')).toBe(true);
    expect(isPersonRawId('919812345678:12@c.us')).toBe(true);
    expect(isPersonRawId('7700123@lid')).toBe(true);
    expect(isPersonRawId('120363@g.us')).toBe(false);
    expect(isPersonRawId('abc@c.us')).toBe(false);
    expect(isPersonRawId('')).toBe(false);
  });
  it('shows a phone only for phone IDs (A6: never guess)', () => {
    expect(phoneFromRawId('919812345678:3@c.us')).toBe('+919812345678');
    expect(phoneFromRawId('7700123@lid')).toBeUndefined();
  });
});

describe('IdResolver (A2)', () => {
  it('merges a privacy ID and a phone ID into one person, preferring the phone ID', () => {
    const r = new IdResolver();
    r.link('7700001@lid', '919800000001@c.us');
    expect(r.canonical('7700001@lid')).toBe('919800000001@c.us');
    expect(r.canonical('919800000001@s.whatsapp.net')).toBe('919800000001@c.us');
    expect(r.rawIdsOf('7700001@lid')).toEqual(['7700001@lid', '919800000001@c.us']);
  });
  it('keeps the phone ID as canonical whichever order links arrive in', () => {
    const r = new IdResolver();
    r.link('919800000001@c.us', '7700001@lid');
    r.link('7700001@lid', '7700002@lid');
    expect(r.canonical('7700002@lid')).toBe('919800000001@c.us');
    r.link('7700002@lid', '919800000001@c.us'); // already linked: no change
    expect(r.rawIdsOf('919800000001@c.us')).toHaveLength(3);
  });
  it('treats unknown IDs as their own person', () => {
    const r = new IdResolver();
    expect(r.canonical('919800000005@c.us')).toBe('919800000005@c.us');
    expect(r.rawIdsOf('919800000005@c.us')).toEqual(['919800000005@c.us']);
  });
  it('never merges two different people', () => {
    const r = new IdResolver();
    r.add('919800000001@c.us');
    r.add('919800000002@c.us');
    expect(r.canonical('919800000001@c.us')).not.toBe(r.canonical('919800000002@c.us'));
  });
});
