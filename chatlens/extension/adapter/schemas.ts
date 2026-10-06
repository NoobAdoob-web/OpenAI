// Runtime shape checks for everything the adapter returns (self-test, rule A8).
// If WhatsApp changes its data, these fail and the extension pauses instead of
// showing a wrong result.

import { z } from 'zod';

const nonEmpty = z.string().min(1);

export const ChatInfoSchema = z.object({
  id: nonEmpty,
  name: z.string(),
  type: z.enum(['individual', 'group', 'community-group']),
  communityId: z.string().optional(),
  isArchived: z.boolean(),
  isAnnouncementGroup: z.boolean(),
});

export const MemberSchema = z.object({
  id: nonEmpty,
  rawIds: z.array(nonEmpty).min(1),
  displayName: nonEmpty,
  phone: z.string().optional(),
  isAdmin: z.boolean(),
  isMe: z.boolean(),
  canOpenPrivateChat: z.boolean(),
});

export const GroupSnapshotSchema = z.object({
  groupId: nonEmpty,
  groupName: z.string(),
  reportedMemberCount: z.number().int().positive(),
  members: z.array(MemberSchema).min(1),
  readAt: z.number(),
});

export const PollSummarySchema = z.object({
  id: nonEmpty,
  question: z.string(),
  creatorName: z.string(),
  createdAt: z.number(),
  optionCount: z.number().int().min(1),
});

export const PollSchema = z.object({
  id: nonEmpty,
  groupId: nonEmpty,
  question: z.string(),
  options: z.array(z.object({ id: nonEmpty, label: z.string() })).min(1),
  multipleChoice: z.boolean(),
  createdAt: z.number(),
  creatorId: nonEmpty,
  reportedVoterCount: z.number().int().min(0),
});

export const VoteSchema = z.object({
  voterId: nonEmpty,
  voterRawIds: z.array(nonEmpty).min(1),
  voterName: z.string().optional(),
  optionIds: z.array(nonEmpty).min(1),
  votedAt: z.number().optional(),
});

export const LocalMessageSchema = z.object({
  id: nonEmpty,
  chatId: nonEmpty,
  chatType: z.enum(['individual', 'group', 'community-group']),
  communityId: z.string().optional(),
  senderId: nonEmpty,
  timestamp: z.number(),
  text: z.string(),
  kind: z.enum(['text', 'link', 'document', 'image', 'video', 'audio', 'other']),
  fileName: z.string().optional(),
  isEdited: z.boolean(),
  isDeletedForEveryone: z.literal(false),
  isViewOnce: z.literal(false),
});
