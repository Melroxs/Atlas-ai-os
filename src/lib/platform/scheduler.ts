// ---------------------------------------------------------------------------
// Atlas Platform — Scheduling logic (pure, no I/O)
//
// One reusable scheduling model drives every recurring task. Schedules never
// execute work; they enqueue into the existing atlas_jobs queue, so retries,
// backoff, concurrency safety and observability are inherited.
//
// This module is the single source of truth for the cadence/backoff maths that
// the SQL (`schedules_fire_due`, `schedules_record_result`) mirrors. Keep them
// in sync — `scheduler.test.ts` pins the contract.
// ---------------------------------------------------------------------------

import {
  MAX_SCHEDULE_BACKOFF_SECONDS,
  MIN_SCHEDULE_INTERVAL_SECONDS,
  type ScheduleDefinition,
  type ScheduleDraft,
} from "./types";

/** Maximum exponent applied to failure backoff (2^6 = 64x). */
export const MAX_BACKOFF_EXPONENT = 6;

/**
 * Exponential backoff for a failing schedule.
 * base * 2^min(failures, 6), capped at 24h. Never returns 0 or negative.
 */
export function scheduleBackoffSeconds(
  intervalSeconds: number,
  consecutiveFailures: number,
): number {
  const base = Math.max(Math.floor(intervalSeconds) || 0, MIN_SCHEDULE_INTERVAL_SECONDS);
  const exponent = Math.max(0, Math.min(Math.floor(consecutiveFailures) || 0, MAX_BACKOFF_EXPONENT));
  return Math.min(base * Math.pow(2, exponent), MAX_SCHEDULE_BACKOFF_SECONDS);
}

/**
 * The next run time for a schedule.
 *
 * `consecutiveFailures = 0` is the healthy path and uses the plain interval.
 */
export function computeNextRunAt(
  nowMs: number,
  intervalSeconds: number,
  consecutiveFailures = 0,
): number {
  const seconds =
    consecutiveFailures > 0
      ? scheduleBackoffSeconds(intervalSeconds, consecutiveFailures)
      : Math.max(Math.floor(intervalSeconds) || 0, MIN_SCHEDULE_INTERVAL_SECONDS);
  return nowMs + seconds * 1000;
}

/** Whether a schedule is eligible to fire at `nowMs`. */
export function isScheduleDue(
  schedule: Pick<ScheduleDefinition, "enabled" | "next_run_at">,
  nowMs: number,
): boolean {
  if (!schedule.enabled) return false;
  const next = Date.parse(schedule.next_run_at);
  if (!Number.isFinite(next)) return false;
  return next <= nowMs;
}

/**
 * Select the due schedules to fire, oldest first.
 * Bounded so a backlog can never stampede the queue in one tick.
 */
export function selectDueSchedules(
  schedules: Array<Pick<ScheduleDefinition, "enabled" | "next_run_at" | "name">>,
  nowMs: number,
  limit = 20,
): Array<Pick<ScheduleDefinition, "enabled" | "next_run_at" | "name">> {
  const max = Math.max(1, Math.min(Math.floor(limit) || 20, 200));
  return schedules
    .filter((s) => isScheduleDue(s, nowMs))
    .sort((a, b) => Date.parse(a.next_run_at) - Date.parse(b.next_run_at))
    .slice(0, max);
}

/**
 * Deterministic idempotency key for one schedule occurrence.
 * Mirrors the SQL `name || ':' || to_char(next_run_at, ...)` contract so a
 * re-fire of the same occurrence is deduplicated rather than double-run.
 */
export function scheduleOccurrenceKey(name: string, nextRunAtMs: number): string {
  const d = new Date(nextRunAtMs);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${name}:${stamp}`;
}

/** Validate a schedule draft against the same rules the database enforces. */
export function validateScheduleDraft(draft: ScheduleDraft): string[] {
  const errors: string[] = [];
  if (!draft.name || draft.name.trim().length === 0) {
    errors.push("Schedule name is required.");
  }
  if (!draft.jobType || draft.jobType.trim().length === 0) {
    errors.push("Schedule job type is required.");
  }
  if (!Number.isFinite(draft.intervalSeconds) || draft.intervalSeconds < MIN_SCHEDULE_INTERVAL_SECONDS) {
    errors.push(`Schedule interval must be at least ${MIN_SCHEDULE_INTERVAL_SECONDS} seconds.`);
  }
  if (draft.priority !== undefined && (draft.priority < 1 || draft.priority > 5)) {
    errors.push("Priority must be between 1 and 5.");
  }
  if (draft.maxAttempts !== undefined && (draft.maxAttempts < 1 || draft.maxAttempts > 10)) {
    errors.push("Max attempts must be between 1 and 10.");
  }
  return errors;
}

/** Human-readable cadence for compact UI display. */
export function describeCadence(intervalSeconds: number): string {
  const s = Math.max(0, Math.floor(intervalSeconds) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3_600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** Compact health label for a schedule row. */
export function describeScheduleHealth(
  schedule: Pick<ScheduleDefinition, "enabled" | "consecutive_failures">,
): "paused" | "healthy" | "degraded" | "failing" {
  if (!schedule.enabled) return "paused";
  const failures = schedule.consecutive_failures ?? 0;
  if (failures === 0) return "healthy";
  if (failures < 3) return "degraded";
  return "failing";
}
