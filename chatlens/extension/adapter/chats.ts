// Chats and groups: listChats, getActiveChat, getGroupSnapshot.

import { isPersonRawId } from '../core/ids';
import type { ChatInfo, ChatType, GroupSnapshot, Member } from '../core/types';
import { note } from './diagnostics';
import { buildResolver, displayNameFor, meCanonical, phoneFor } from './ids';
import { attr, collection, findById, models, widStr, type AnyObj } from './wa';

/** Chats that are people, groups or community groups (not status updates or channels). */
function isRealChat(id: string): boolean {
  return id.endsWith('@c.us') || id.endsWith('@g.us') || id.endsWith('@lid');
}

function groupMetadataOf(chat: AnyObj, id: string): AnyObj | undefined {
  return attr(chat, 'groupMetadata') ?? findById(collection('GroupMetadata'), id);
}

export function chatInfo(chat: AnyObj): ChatInfo | undefined {
  const id = widStr(attr(chat, 'id'));
  if (!id || !isRealChat(id)) return undefined;
  const isGroup = id.endsWith('@g.us');
  const gm = isGroup ? groupMetadataOf(chat, id) : undefined;
  const parent = widStr(attr(gm, 'parentGroup'));
  const type: ChatType = !isGroup ? 'individual' : parent ? 'community-group' : 'group';
  const name = attr(chat, 'formattedTitle') ?? attr(chat, 'name') ?? attr(gm, 'subject');
  return {
    id,
    name: typeof name === 'string' && name ? name : isGroup ? 'Unnamed group' : displayNameFor([id]),
    type,
    communityId: parent,
    isArchived: !!attr(chat, 'archive'),
    isAnnouncementGroup: !!attr(gm, 'defaultSubgroup') || !!attr(gm, 'isParentGroup'),
  };
}

export function listChats(): ChatInfo[] {
  return models(collection('Chat'))
    .map(chatInfo)
    .filter((c): c is ChatInfo => !!c);
}

export function activeChatModel(): AnyObj | undefined {
  const chats = collection('Chat');
  try {
    if (typeof chats?.getActive === 'function') {
      const a = chats.getActive();
      if (a) return a;
    }
  } catch {
    /* fall back below */
  }
  return models(chats).find((c) => attr(c, 'active') === true);
}

export function getActiveChat(): ChatInfo | null {
  const chat = activeChatModel();
  return chat ? (chatInfo(chat) ?? null) : null;
}

export function getGroupSnapshot(groupId: string): GroupSnapshot {
  const chat = findById(collection('Chat'), groupId);
  if (!chat) throw new Error('group not found');
  const gm = groupMetadataOf(chat, groupId);
  if (!gm) throw new Error('group details not loaded');

  const participants = models(attr(gm, 'participants'));
  const resolver = buildResolver(participants);
  const me = meCanonical(resolver);

  const members: Member[] = [];
  for (const p of participants) {
    const raw = widStr(attr(p, 'id'));
    if (!raw || !isPersonRawId(raw)) throw new Error('a member has no usable ID');
    const id = resolver.canonical(raw);
    const rawIds = resolver.rawIdsOf(raw);
    const phone = phoneFor(rawIds);
    members.push({
      id,
      rawIds,
      displayName: id === me ? 'You' : displayNameFor(rawIds),
      phone,
      isAdmin: !!attr(p, 'isAdmin') || !!attr(p, 'isSuperAdmin'),
      isMe: id === me,
      canOpenPrivateChat: !!phone,
    });
  }

  // Rule A3: the member count WhatsApp itself reports. "size" is WhatsApp's own
  // figure. If it is missing we fall back to the list length and say so, because
  // then the check is not independent.
  const size = attr(gm, 'size');
  const independent = typeof size === 'number' && size > 0;
  note('memberCountSource', independent ? 'whatsapp-group-size' : 'participant-list-only (not independent)');

  const name = attr(chat, 'formattedTitle') ?? attr(gm, 'subject');
  return {
    groupId,
    groupName: typeof name === 'string' ? name : 'Unnamed group',
    reportedMemberCount: independent ? size : participants.length,
    members,
    readAt: Date.now(),
  };
}
