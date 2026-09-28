/**
 * The Content Engine's automation recurrence, tested against the REAL Atlas
 * scheduler contract.
 *
 * These tests deliberately assert against the SQL that will ship
 * (20260935, still unapplied) and against the 20260913/20260918 definitions they
 * depend on, rather than against a hypothetical mock. A mock of a scheduler API
 * that does not exist would prove nothing; these prove the Content Engine calls
 * the scheduler Atlas actually has, with the arguments it actually accepts.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTENT_AUTOMATION_TICK_JOB_TYPE,
  MIN_CONTENT_AUTOMATION_INTERVAL_SECONDS,
  automationScheduleAction,
  contentAutomationScheduleName,
  isSchedulableInterval,
} from "./automation";
import { AUTOMATION_FREQUENCIES } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../supabase/migrations");
const read = (file: string) => readFileSync(resolve(MIGRATIONS, file), "utf8");

const CONTENT = read("20260935_atlas_content_engine.sql");
const PLATFORM = read("20260913_atlas_platform_infrastructure.sql");
const HARDENING = read("20260918_atlas_security_hardening.sql");

/** The body of one `create or replace function` declaration. */
function body(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const asDollar = sql.indexOf("as $$", start);
  return sql.slice(sql.indexOf("$$", asDollar + 3), sql.indexOf("$$;", asDollar));
}

const AUTOMATION_UPSERT = body(CONTENT, "content_automation_upsert");
const LIST_DUE = body(CONTENT, "content_automation_list_due");

// ---------------------------------------------------------------------------
// The existing scheduler contract this repair depends on
// ---------------------------------------------------------------------------

describe("the existing Atlas scheduler contract is what the Content Engine uses", () => {
  it("registers a real, durable, tenant-scoped schedule row", () => {
    // atlas_schedules is the ONE schedule registry. The Content Engine adds no
    // table of its own.
    expect(PLATFORM).toMatch(/create table if not exists public\.atlas_schedules/);
    expect(CONTENT).not.toMatch(/create table[\s\S]{0,80}schedule/i);

    // A schedule row is durable: it carries next_run_at and survives restarts.
    expect(PLATFORM).toMatch(/next_run_at\s+timestamptz not null/);
    expect(PLATFORM).toMatch(/last_run_at\s+timestamptz/);
  });

  it("uses the scheduler's real upsert, with the scheduler's real parameters", () => {
    // schedules_upsert exists in 20260913 and takes exactly these parameters.
    const upsert = body(PLATFORM, "schedules_upsert");
    for (const p of [
      "p_name",
      "p_job_type",
      "p_interval_seconds",
      "p_payload",
      "p_priority",
      "p_max_attempts",
      "p_tenant_id",
      "p_tags",
      "p_enabled",
      "p_description",
    ]) {
      expect(upsert, `schedules_upsert must accept ${p}`).toMatch(new RegExp(`\\b${p}\\b`));
    }

    // ...and the Content Engine calls it with those same names.
    expect(AUTOMATION_UPSERT).toMatch(/perform public\.schedules_upsert\(/);
    for (const p of [
      "p_name             => public.content_automation_schedule_name(v_org)",
      "p_job_type         => 'content_automation_tick'",
      "p_interval_seconds => v_row.\"intervalSeconds\"",
      "p_tenant_id        => v_org",
      "p_enabled          => true",
    ]) {
      expect(AUTOMATION_UPSERT).toContain(p);
    }
  });

  it("cannot be reached from a browser: schedules_* is service-role only", () => {
    // This is what makes calling it from inside a SECURITY DEFINER function the
    // only path in, rather than a privilege escalation.
    expect(HARDENING).toMatch(/'schedules_upsert','schedules_set_enabled'/);
    expect(HARDENING).toMatch(/'schedules_fire_due','schedules_record_result'/);
    expect(HARDENING).toMatch(
      /revoke execute on function %s from public, anon, authenticated/,
    );
  });

  it("lets the scheduler actually advance the next occurrence", () => {
    // Recurrence is the scheduler's job: schedules_fire_due creates the job and
    // advances next_run_at in one transaction.
    const fire = body(PLATFORM, "schedules_fire_due");
    expect(fire).toMatch(/next_run_at <= now\(\)/);
    expect(fire).toMatch(/for update skip locked/);
    expect(fire).toMatch(/idempotency_key/);
    expect(fire).toMatch(/next_run_at/);
  });
});

// ---------------------------------------------------------------------------
// Test 1 — a schedule is created
// ---------------------------------------------------------------------------

describe("an enabled automation registers a recurring schedule", () => {
  it("registers on the daily cadence", () => {
    const daily = AUTOMATION_FREQUENCIES.find((f) => f.id === "daily");
    expect(daily?.seconds).toBe(86_400);

    const action = automationScheduleAction({
      organizationId: "org-1",
      enabled: true,
      intervalSeconds: daily?.seconds ?? null,
    });
    expect(action).toEqual({
      kind: "register",
      name: "content-automation:org-1",
      intervalSeconds: 86_400,
    });
  });

  it("registers through schedules_upsert, not through a private mechanism", () => {
    // The registration is unconditional on the enabled+interval branch, so a
    // save cannot silently skip it.
    expect(AUTOMATION_UPSERT).toMatch(
      /if v_row\.enabled and v_row\."intervalSeconds" is not null and v_row\."intervalSeconds" >= 30 then[\s\S]{0,200}perform public\.schedules_upsert\(/,
    );
  });

  it("takes the cadence from the stored automation row, not a hardcoded value", () => {
    // Every user-facing frequency must actually change the schedule.
    expect(AUTOMATION_UPSERT).toContain('p_interval_seconds => v_row."intervalSeconds"');
    for (const frequency of AUTOMATION_FREQUENCIES) {
      if (frequency.seconds === null) continue;
      expect(isSchedulableInterval(frequency.seconds)).toBe(true);
      const action = automationScheduleAction({
        organizationId: "org-1",
        enabled: true,
        intervalSeconds: frequency.seconds,
      });
      expect(action.kind).toBe("register");
      expect(action.kind === "register" && action.intervalSeconds).toBe(frequency.seconds);
    }
  });

  it("enqueues the job type the worker actually claims", () => {
    expect(AUTOMATION_UPSERT).toContain(`p_job_type         => '${CONTENT_AUTOMATION_TICK_JOB_TYPE}'`);
    // The worker must be willing to dequeue it, or recurrence is a no-op.
    const worker = readFileSync(
      resolve(HERE, "../../../supabase/functions/content-engine-worker/index.ts"),
      "utf8",
    );
    expect(worker).toContain(`"${CONTENT_AUTOMATION_TICK_JOB_TYPE}"`);
    expect(worker).toContain(`case "${CONTENT_AUTOMATION_TICK_JOB_TYPE}"`);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — changing the cadence updates the same schedule
// ---------------------------------------------------------------------------

describe("changing the cadence updates, never duplicates", () => {
  it("keys the schedule on a deterministic per-organization name", () => {
    expect(contentAutomationScheduleName("org-1")).toBe("content-automation:org-1");
    // Stable across calls: the identity cannot drift between saves.
    expect(contentAutomationScheduleName("org-1")).toBe(contentAutomationScheduleName("org-1"));
    // And distinct per organization.
    expect(contentAutomationScheduleName("org-2")).not.toBe(contentAutomationScheduleName("org-1"));
  });

  it("matches the SQL identity exactly", () => {
    // The TS mirror and the SQL function must not drift, or a save would
    // create a second schedule under a different name.
    const sqlName = body(CONTENT, "content_automation_schedule_name");
    expect(sqlName).toContain("'content-automation:' || p_organization::text");
    expect(AUTOMATION_UPSERT).toContain("public.content_automation_schedule_name(v_org)");
  });

  it("relies on a UNIQUE schedule name, so the upsert cannot fan out", () => {
    expect(PLATFORM).toMatch(/name\s+text not null unique/);
    // schedules_upsert looks the row up BY name and UPDATES it in place
    // (insert only when absent), so the same name can never produce a second row.
    const upsert = body(PLATFORM, "schedules_upsert");
    expect(upsert).toMatch(/from public\.atlas_schedules where name = p_name/);
    expect(upsert).toMatch(/if v_id is null then[\s\S]{0,80}insert into public\.atlas_schedules/);
    expect(upsert).toMatch(/update public\.atlas_schedules/);
    // daily -> weekly is an interval change on the SAME row, not a new row.
    const daily = automationScheduleAction({ organizationId: "org-1", enabled: true, intervalSeconds: 86_400 });
    const weekly = automationScheduleAction({ organizationId: "org-1", enabled: true, intervalSeconds: 604_800 });
    expect(daily.kind === "register" && weekly.kind === "register").toBe(true);
    expect(weekly.name).toBe(daily.name);
    expect(weekly.kind === "register" && weekly.intervalSeconds).toBe(604_800);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — disabling stops generation
// ---------------------------------------------------------------------------

describe("disabling automation stops future generation", () => {
  it("pauses the schedule instead of deleting it", () => {
    const action = automationScheduleAction({
      organizationId: "org-1",
      enabled: false,
      intervalSeconds: 86_400,
    });
    expect(action).toEqual({ kind: "pause", name: "content-automation:org-1" });
    expect(AUTOMATION_UPSERT).toMatch(/perform public\.schedules_set_enabled\(/);
    expect(AUTOMATION_UPSERT).toMatch(
      /p_name {4}=> public\.content_automation_schedule_name\(v_org\),\s*\n\s*p_enabled => false/,
    );
  });

  it("treats 'Manual only' as paused too", () => {
    const manual = AUTOMATION_FREQUENCIES.find((f) => f.id === "manual");
    expect(manual?.seconds).toBeNull();
    const action = automationScheduleAction({
      organizationId: "org-1",
      enabled: true,
      intervalSeconds: manual?.seconds ?? null,
    });
    expect(action.kind).toBe("pause");
    expect(isSchedulableInterval(null)).toBe(false);
    // The SQL branch uses the same gate, so a NULL interval never registers.
    expect(AUTOMATION_UPSERT).toMatch(
      /if v_row\.enabled and v_row\."intervalSeconds" is not null and v_row\."intervalSeconds" >= 30 then/,
    );
  });

  it("blocks generation three independent ways", () => {
    // (1) the schedule is paused, so nothing is enqueued at all;
    // (2) content_automation_list_due only ever returns enabled automations;
    // (3) both tick handlers skip a disabled automation.
    expect(LIST_DUE).toMatch(/where a\.enabled = true/);
    expect(LIST_DUE).toMatch(/a\."intervalSeconds" is not null/);

    const worker = readFileSync(
      resolve(HERE, "../../../supabase/functions/content-engine-worker/index.ts"),
      "utf8",
    );
    expect(worker).toMatch(/if \(!organizationId \|\| automation\.enabled !== true\) continue/);

    const jobs = readFileSync(resolve(HERE, "jobs.ts"), "utf8");
    expect(jobs).toMatch(/if \(!automation\.enabled \|\| !automation\.organizationId\) continue/);
  });

  it("keeps requireApproval true by default and never set by the scheduler", () => {
    expect(CONTENT).toMatch(/"requireApproval"\s+boolean not null default true/);
    expect(CONTENT).toMatch(/"autoPublish"\s+boolean not null default false/);
    // The registration branch writes schedule fields only; it must not touch
    // approval or auto-publish.
    const registration = AUTOMATION_UPSERT.slice(
      AUTOMATION_UPSERT.indexOf("if v_row.enabled and v_row"),
      AUTOMATION_UPSERT.indexOf("-- PROMPT FIRST OCCURRENCE"),
    );
    expect(registration).not.toMatch(/requireApproval/i);
    expect(registration).not.toMatch(/autoPublish/i);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — tenant isolation
// ---------------------------------------------------------------------------

describe("schedules stay tenant-scoped", () => {
  it("always writes the schedule for the caller's OWN organization", () => {
    // v_org is my_tenant_id(), guarded at the top of the function. There is no
    // caller-supplied organization parameter on content_automation_upsert.
    expect(AUTOMATION_UPSERT).toMatch(/v_org uuid := public\.my_tenant_id\(\)/);
    expect(AUTOMATION_UPSERT).toMatch(
      /if v_org is null then[\s\S]{0,120}raise exception 'Access denied: no active Atlas organization'/,
    );
    expect(AUTOMATION_UPSERT).not.toMatch(/p_organization/i);
    expect(AUTOMATION_UPSERT).toContain("p_tenant_id        => v_org");
  });

  it("scopes topic selection to the organization the tick is walking", () => {
    // content_next_topic refuses a foreign organization for an ordinary member
    // and reads only that organization's covered topics.
    const next = body(CONTENT, "content_next_topic");
    expect(next).toMatch(/"organizationId" is not distinct from v_org/);
    expect(next).toMatch(/cannot select a topic for another organization/);
  });

  it("keeps two organizations' schedules distinct", () => {
    const a = automationScheduleAction({ organizationId: "org-a", enabled: true, intervalSeconds: 86_400 });
    const b = automationScheduleAction({ organizationId: "org-b", enabled: true, intervalSeconds: 86_400 });
    expect(a.kind === "register" && b.kind === "register" && a.name === b.name).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — repeated saves do not stack schedules
// ---------------------------------------------------------------------------

describe("repeated saves are idempotent", () => {
  it("produces the same identity every time", () => {
    const saves = Array.from({ length: 25 }, () =>
      automationScheduleAction({ organizationId: "org-1", enabled: true, intervalSeconds: 86_400 }),
    );
    expect(new Set(saves.map((s) => s.kind === "register" && s.name)).size).toBe(1);
    for (const save of saves) expect(save.kind).toBe("register");
  });

  it("toggles between enabled and disabled without leaving stray identities", () => {
    const names = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      names.add(automationScheduleAction({ organizationId: "org-1", enabled: true, intervalSeconds: 86_400 }).name);
      names.add(automationScheduleAction({ organizationId: "org-1", enabled: false, intervalSeconds: 86_400 }).name);
    }
    expect(names.size).toBe(1);
  });

  it("cannot stack a tick per save either", () => {
    // The one-shot bootstrap is bucketed to the hour, so repeated saves inside
    // the same hour collapse onto one durable job.
    expect(AUTOMATION_UPSERT).toMatch(
      /p_idempotency_key => 'content:automation-tick:'[\s\S]{0,120}'YYYYMMDDHH24'/,
    );
    expect(AUTOMATION_UPSERT).toMatch(/date_trunc\('hour', now\(\) at time zone 'utc'\)/);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — a double fire cannot produce two packages
// ---------------------------------------------------------------------------

describe("a scheduler double-fire does not double-generate", () => {
  it("deduplicates the enqueue on a per-occurrence key", () => {
    const fire = body(PLATFORM, "schedules_fire_due");
    // One job per schedule occurrence, keyed on name + next_run_at.
    expect(fire).toMatch(/v_key := v_row\.name \|\| ':' \|\| to_char\(v_row\.next_run_at/);
    expect(fire).toMatch(/on conflict do nothing/);
    expect(fire).toMatch(/for update skip locked/);
  });

  it("keeps the Content Engine's own per-occurrence generation key", () => {
    // Belt and braces: even if two ticks ran, the generated package is keyed.
    const jobs = readFileSync(resolve(HERE, "jobs.ts"), "utf8");
    expect(jobs).toMatch(/idempotencyKey: `content:auto:\$\{automation\.organizationId\}:\$\{Math\.floor\(ports\.now\(\) \/ 1000\)\}`/);
  });

  it("does not let the scheduler reach publication", () => {
    // Generation is the only thing the schedule may cause.
    expect(AUTOMATION_UPSERT).toMatch(/p_job_type {9}=> 'content_automation_tick'/);
    expect(AUTOMATION_UPSERT).not.toMatch(/content_publish_(blog|youtube|linkedin)/);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — the pure module matches the rules the SQL enforces
// ---------------------------------------------------------------------------

describe("the TypeScript mirror matches the SQL", () => {
  it("uses the scheduler's own minimum interval", () => {
    // atlas_schedules rejects anything under 30s, and schedules_upsert raises.
    expect(PLATFORM).toMatch(/interval_seconds\s+bigint not null check \(interval_seconds >= 30\)/);
    expect(MIN_CONTENT_AUTOMATION_INTERVAL_SECONDS).toBe(30);
    expect(isSchedulableInterval(29)).toBe(false);
    expect(isSchedulableInterval(30)).toBe(true);
  });

  it("applies the same >= 30 gate the SQL branch uses", () => {
    expect(AUTOMATION_UPSERT).toContain('v_row."intervalSeconds" >= 30');
  });

  it("reports the registered schedule back to the caller honestly", () => {
    // The settings screen can show what is actually registered rather than
    // implying a scheduler that does not exist.
    expect(AUTOMATION_UPSERT).toMatch(/'scheduleRegistered'/);
    expect(AUTOMATION_UPSERT).toMatch(/'scheduleName', public\.content_automation_schedule_name\(v_org\)/);
  });
});
