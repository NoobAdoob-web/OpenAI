// Shape checks for everything the poll reader returns (rule A8). If WhatsApp
// changes its data, these fail and the user sees an error, never a wrong list.

import { z } from 'zod';

const nonEmpty = z.string().min(1);

const MemberSchema = z.object({
  id: nonEmpty,
  rawIds: z.array(nonEmpty).min(1),
  displayName: nonEmpty,
  phone: z.string().optional(),
  isAdmin: z.boolean(),
  isMe: z.boolean(),
  canOpenPrivateChat: z.boolean(),
});

export const PollCheckDataSchema = z.object({
  snapshot: z.object({
    groupId: nonEmpty,
    groupName: z.string(),
    reportedMemberCount: z.number().int().positive(),
    members: z.array(MemberSchema).min(1),
    readAt: z.number(),
  }),
  poll: z.object({
    id: nonEmpty,
    groupId: nonEmpty,
    question: z.string(),
    options: z.array(z.object({ id: nonEmpty, label: z.string() })).min(1),
    multipleChoice: z.boolean(),
    createdAt: z.number(),
    creatorId: nonEmpty,
    reportedVoterCount: z.number().int().min(0),
  }),
  votes: z.array(
    z.object({
      voterId: z.string(),
      voterRawIds: z.array(z.string()),
      voterName: z.string().optional(),
      optionIds: z.array(nonEmpty).min(1),
      votedAt: z.number().optional(),
    }),
  ),
  sources: z.object({ whatsapp: z.number().nullable(), database: z.number().nullable() }),
  crossChecked: z.boolean(),
});
