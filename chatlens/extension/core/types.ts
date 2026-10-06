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

// ---- Search / coverage shapes ----

export type ChatType = 'individual' | 'group' | 'community-group';

export interface LocalMessage {
  id: string;
  chatId: string;
  chatType: ChatType;
  communityId?: string;
  senderId: PersonId; // canonical, after rule A2
  timestamp: number; // epoch ms
  text: string; // message body or media caption
  kind: 'text' | 'link' | 'document' | 'image' | 'video' | 'audio' | 'other';
  fileName?: string;
  isEdited: boolean;
  isDeletedForEveryone: boolean; // always excluded (A14)
  isViewOnce: boolean; // always excluded (A14)
}

export interface ChatInfo {
  id: string;
  name: string;
  type: ChatType;
  communityId?: string;
  isArchived: boolean;
  isAnnouncementGroup: boolean;
}

export type Status = 'ready' | 'log-in' | 'paused';

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  note?: string; // plain-English note; never contains names or chat content
}

export interface SelfTestResult {
  ok: boolean;
  checks: SelfTestCheck[];
}
