// Shared data shapes (PID section 13). These cross the page ↔ extension
// boundary, so they must stay plain JSON (no class instances, no functions).

export type PersonId = string; // canonical ID after resolving phone-based and privacy IDs (rule A2)

export interface Member {
  id: PersonId;
  rawIds: string[]; // every internal ID seen for this person
  displayName: string; // exactly as the user sees it in WhatsApp
  phone?: string; // only if WhatsApp exposes it
  isAdmin: boolean;
  isMe: boolean;
  canOpenPrivateChat: boolean;
}

export interface PollOption {
  id: string;
  label: string;
}

export interface Poll {
  id: string;
  groupId: string;
  question: string;
  options: PollOption[];
  multipleChoice: boolean;
  createdAt: number; // epoch ms
  creatorId: PersonId;
  reportedVoterCount: number; // the total WhatsApp itself shows
}

export interface Vote {
  voterId: PersonId;
  voterRawIds: string[]; // raw IDs behind voterId, used to prove the voter is resolvable (A2)
  voterName?: string; // name as WhatsApp shows it, if known (used for people who left)
  optionIds: string[];
  votedAt?: number;
}

export interface GroupSnapshot {
  groupId: string;
  groupName: string;
  reportedMemberCount: number; // the count WhatsApp itself shows
  members: Member[];
  readAt: number;
}

export type CheckFailureReason =
  | 'MEMBER_COUNT_MISMATCH'
  | 'VOTE_COUNT_MISMATCH'
  | 'UNRESOLVED_VOTER'
  | 'BALANCE_FAILED'
  | 'ADAPTER_ERROR';

export type CheckResult =
  | {
      ok: true;
      summary: { members: number; voted: number; notVoted: number; votedLeft: number };
      notVoted: Member[];
      votedByOption: Record<string, Member[]>;
      votedLeft: { id: PersonId; displayName: string }[];
    }
  | { ok: false; reason: CheckFailureReason; userMessage: string; detail?: string };
