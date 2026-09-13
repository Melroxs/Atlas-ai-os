import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  describeCadence,
  describeScheduleHealth,
  isScheduleDue,
  scheduleBackoffSeconds,
  scheduleOccurrenceKey,
  selectDueSchedules,
  validateScheduleDraft,
} from "./scheduler";

const MINUTE = 60_000;

describe("scheduleBackoffSeconds", () => {
  it("uses the base interval with no failures", () => {
    expect(scheduleBackoffSeconds(600, 0)).toBe(600);
  });

  it("doubles per failure", () => {
    expect(scheduleBackoffSeconds(600, 1)).toBe(1200);
    expect(scheduleBackoffSeconds(600, 2)).toBe(2400);
    expect(scheduleBackoffSeconds(600, 3)).toBe(4800);
  });

  it("caps the exponent so it cannot grow unbounded", () => {
    // 2^6 = 64x, then frozen regardless of further failures.
    expect(scheduleBackoffSeconds(600, 6)).toBe(600 * 64);
    expect(scheduleBackoffSeconds(600, 50)).toBe(600 * 64);
  });

  it("never exceeds the 24h cap", () => {
    expect(scheduleBackoffSeconds(3600, 6)).toBe(86_400);
  });

  it("enforces the minimum interval and never returns zero", () => {
    expect(scheduleBackoffSeconds(0, 0)).toBe(30);
    expect(scheduleBackoffSeconds(-5, 0)).toBe(30);
  });
});

describe("computeNextRunAt", () => {
  it("adds the plain interval when healthy", () => {
    expect(computeNextRunAt(1_000_000, 3600)).toBe(1_000_000 + 3600_000);
  });

  it("backs off when failing", () => {
    expect(computeNextRunAt(0, 600, 2)).toBe(2400_000);
  });
});

describe("isScheduleDue", () => {
  const now = Date.parse("2026-09-13T12:00:00Z");

  it("is due when next_run_at is in the past", () => {
    expect(
      isScheduleDue({ enabled: true, next_run_at: "2026-09-13T11:00:00Z" }, now),
    ).toBe(true);
  });

  it("is not due when disabled even if the time passed", () => {
    expect(
      isScheduleDue({ enabled: false, next_run_at: "2026-09-13T11:00:00Z" }, now),
    ).toBe(false);
  });

  it("is not due when next_run_at is in the future", () => {
    expect(
      isScheduleDue({ enabled: true, next_run_at: "2026-09-13T13:00:00Z" }, now),
    ).toBe(false);
  });

  it("fails closed on an unparseable timestamp", () => {
    expect(isScheduleDue({ enabled: true, next_run_at: "not-a-date" }, now)).toBe(false);
  });
});

describe("selectDueSchedules", () => {
  const now = Date.parse("2026-09-13T12:00:00Z");
  const schedules = [
    { name: "c", enabled: true, next_run_at: "2026-09-13T09:00:00Z" },
    { name: "a", enabled: true, next_run_at: "2026-09-13T10:00:00Z" },
    { name: "later", enabled: true, next_run_at: "2026-09-13T18:00:00Z" },
    { name: "paused", enabled: false, next_run_at: "2026-09-13T01:00:00Z" },
  ];

  it("selects only due, enabled schedules in oldest-first order", () => {
    expect(selectDueSchedules(schedules, now).map((s) => s.name)).toEqual(["c", "a"]);
  });

  it("respects the bound", () => {
    expect(selectDueSchedules(schedules, now, 1).map((s) => s.name)).toEqual(["c"]);
  });

  it("clamps the bound to a safe maximum", () => {
    expect(selectDueSchedules(schedules, now, 10_000)).toHaveLength(2);
  });
});

describe("scheduleOccurrenceKey", () => {
  it("is deterministic for one occurrence", () => {
    const t = Date.parse("2026-09-13T12:34:56Z");
    expect(scheduleOccurrenceKey("knowledge-source-check", t)).toBe(
      "knowledge-source-check:20260913123456",
    );
  });

  it("differs across occurrences so retries dedupe but new runs do not", () => {
    const a = scheduleOccurrenceKey("sweep", Date.parse("2026-09-13T12:00:00Z"));
    const b = scheduleOccurrenceKey("sweep", Date.parse("2026-09-13T13:00:00Z"));
    expect(a).not.toBe(b);
  });
});

describe("validateScheduleDraft", () => {
  it("accepts a valid draft", () => {
    expect(
      validateScheduleDraft({ name: "s", jobType: "knowledge_source_check", intervalSeconds: 60 }),
    ).toEqual([]);
  });

  it("requires a name, a job type and a safe interval", () => {
    const errors = validateScheduleDraft({ name: "  ", jobType: "", intervalSeconds: 5 });
    expect(errors).toHaveLength(3);
  });

  it("bounds priority and max attempts", () => {
    expect(
      validateScheduleDraft({
        name: "s",
        jobType: "t",
        intervalSeconds: 60,
        priority: 9,
        maxAttempts: 99,
      }),
    ).toHaveLength(2);
  });
});

describe("describeCadence / describeScheduleHealth", () => {
  it("renders a compact cadence", () => {
    expect(describeCadence(45)).toBe("45s");
    expect(describeCadence(600)).toBe("10m");
    expect(describeCadence(21_600)).toBe("6h");
    expect(describeCadence(172_800)).toBe("2d");
  });

  it("reports honest schedule health", () => {
    expect(describeScheduleHealth({ enabled: false, consecutive_failures: 0 })).toBe("paused");
    expect(describeScheduleHealth({ enabled: true, consecutive_failures: 0 })).toBe("healthy");
    expect(describeScheduleHealth({ enabled: true, consecutive_failures: 1 })).toBe("degraded");
    expect(describeScheduleHealth({ enabled: true, consecutive_failures: 9 })).toBe("failing");
  });
});

describe("MINUTE constant sanity", () => {
  it("keeps the backoff cap above any base interval", () => {
    expect(scheduleBackoffSeconds(86_400, 1)).toBe(86_400);
    expect(MINUTE).toBe(60_000);
  });
});
