// ---------------------------------------------------------------------------
// Atlas Communication Drafting Engine — Barrel Export
// ---------------------------------------------------------------------------

export {
  generateDraft,
  type DraftType,
  type DraftTone,
  type DraftRecipient,
  type DraftContext,
  type CommunicationDraft,
} from "./drafting";

export {
  generateDailyBriefing,
  type BriefingPriority,
  type BriefingActionItem,
  type BriefingSection,
  type DailyBriefing,
} from "./daily-briefing";

export {
  trackDeadlines,
  buildDeadlineSummary,
  type DeadlineType,
  type DeadlineStatus,
  type DeadlineSeverity,
  type Deadline,
  type DeadlineSummary,
  type JurisdictionRule,
  DEFAULT_JURISDICTION_RULES,
} from "./deadline-tracker";

export {
  scheduleFollowUps,
  buildFollowUpSummary,
  type FollowUpType,
  type FollowUpPriority,
  type FollowUpStatus,
  type FollowUp,
  type FollowUpSummary,
} from "./follow-up-scheduler";
