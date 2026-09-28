// ---------------------------------------------------------------------------
// Atlas Content Engine — automation schedule identity (pure)
//
// Automated content runs on ATLAS'S EXISTING RECURRING SCHEDULER
// (`public.atlas_schedules` + `schedules_fire_due`, migration 20260913), not on
// a second scheduler and not on a tick that re-enqueues itself. The SQL that
// registers the schedule lives in `content_automation_upsert`; this module is
// the pure mirror of the two rules that decide it, so the settings screen and
// the test suite can reason about them without a database.
//
// Two rules, and only two:
//
//   1. IDENTITY. `atlas_schedules.name` is UNIQUE and `schedules_upsert` keys on
//      it, so a deterministic per-organization name is what guarantees "one
//      recurring schedule per organization". Saving the same settings a
//      hundred times updates one row; it never stacks schedules.
//
//   2. ENABLEDNESS. A schedule is registered only when automation is on AND a
//      real cadence is set. Otherwise the existing schedule is PAUSED through
//      `schedules_set_enabled` rather than deleted, so re-enabling keeps the
//      cadence and the run history.
//
// This module deliberately does NOT decide whether a package is published.
// `requireApproval` stays true by default and nothing here touches it: a
// scheduled tick only PREPARES a package for human review.
// ---------------------------------------------------------------------------

/** Prefix of every Content Engine schedule, matching the SQL literal. */
export const CONTENT_AUTOMATION_SCHEDULE_PREFIX = "content-automation";

/**
 * The minimum interval `atlas_schedules` accepts. The SQL enforces the same
 * floor (`interval_seconds >= 30`), and `schedules_upsert` raises below it, so
 * a cadence the user can actually pick (daily / every 2 days / weekly) is
 * always far above it.
 */
export const MIN_CONTENT_AUTOMATION_INTERVAL_SECONDS = 30;

/** What the recurring schedule should be doing for a given automation row. */
export type AutomationScheduleAction =
  | { kind: "register"; name: string; intervalSeconds: number }
  | { kind: "pause"; name: string }
  | { kind: "none"; name: string };

/**
 * The deterministic identity of one organization's automation schedule.
 * Mirrors `public.content_automation_schedule_name(uuid)`.
 */
export function contentAutomationScheduleName(organizationId: string): string {
  return `${CONTENT_AUTOMATION_SCHEDULE_PREFIX}:${organizationId}`;
}

/** Is a cadence the scheduler can actually hold? */
export function isSchedulableInterval(intervalSeconds: number | null | undefined): boolean {
  return (
    typeof intervalSeconds === "number" &&
    Number.isFinite(intervalSeconds) &&
    intervalSeconds >= MIN_CONTENT_AUTOMATION_INTERVAL_SECONDS
  );
}

/**
 * Decide register / pause / nothing for one save of the automation settings.
 * This is the rule `content_automation_upsert` applies in SQL; it is duplicated
 * in TypeScript only so the UI can explain itself and the tests can pin it.
 */
export function automationScheduleAction(input: {
  organizationId: string;
  enabled: boolean;
  intervalSeconds: number | null;
}): AutomationScheduleAction {
  const name = contentAutomationScheduleName(input.organizationId);
  if (input.enabled && isSchedulableInterval(input.intervalSeconds)) {
    return { kind: "register", name, intervalSeconds: Math.floor(input.intervalSeconds as number) };
  }
  if (input.enabled) {
    // Automation is on but the cadence is manual/too short: there is nothing
    // to register, and nothing to pause either if the user has never saved a
    // cadence. Pausing is still the safe answer, so the schedule can never be
    // left firing from a previous save.
    return { kind: "pause", name };
  }
  return { kind: "pause", name };
}

/**
 * The job type the recurring schedule enqueues. Kept here so the SQL, the
 * worker's claim list and the test suite name the same thing.
 */
export const CONTENT_AUTOMATION_TICK_JOB_TYPE = "content_automation_tick";
