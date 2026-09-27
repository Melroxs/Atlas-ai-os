import { describe, it, expect } from "vitest";
import {
  ALL_DELETION_DEGREES,
  ARCHIVE_DELETION_DEGREES,
  DELETION_CONFIRMATION_WORD,
  FILE_DELETION_DEGREES,
  INGESTION_DELETE_ORG_ROLES,
  INGESTION_DELETE_PLATFORM_ROLE,
  canDeleteIngestedFiles,
  deletionDegreesFor,
  describeDeletion,
  ingestionDeleteDeniedReason,
  isDeletionDegree,
  resolveDeletionDegree,
} from "./deletion";

describe("graded deletion — depths", () => {
  it("offers two depths for a single file and three for an archive", () => {
    expect(deletionDegreesFor("file")).toHaveLength(2);
    expect(deletionDegreesFor("archive")).toHaveLength(3);
    expect(deletionDegreesFor("file").map((d) => d.degree)).toEqual([
      "knowledge",
      "knowledge_and_file",
    ]);
    expect(deletionDegreesFor("archive").map((d) => d.degree)).toEqual([
      "knowledge",
      "knowledge_and_files",
      "everything",
    ]);
  });

  it("orders depths from least to most destructive", () => {
    for (const target of ["file", "archive"] as const) {
      const specs = deletionDegreesFor(target);
      const destructive = specs.map((s) => s.destructive);
      // non-destructive options come first
      expect(destructive).toEqual([...destructive].sort((a, b) => Number(a) - Number(b)));
    }
  });

  it("only the deepest archive option removes the record", () => {
    const removingRecord = ARCHIVE_DELETION_DEGREES.filter((d) => d.deletesRecord);
    expect(removingRecord.map((d) => d.degree)).toEqual(["everything"]);
  });

  it("only the storage depths remove the original bytes", () => {
    expect(FILE_DELETION_DEGREES.filter((d) => d.deletesStorage).map((d) => d.degree)).toEqual([
      "knowledge_and_file",
    ]);
    expect(
      ARCHIVE_DELETION_DEGREES.filter((d) => d.deletesStorage).map((d) => d.degree),
    ).toEqual(["knowledge_and_files", "everything"]);
  });

  it("exports a de-duplicated union of every degree", () => {
    expect(ALL_DELETION_DEGREES.sort()).toEqual(
      ["everything", "knowledge", "knowledge_and_file", "knowledge_and_files"].sort(),
    );
  });
});

describe("graded deletion — resolution", () => {
  it("resolves a valid degree for its own target", () => {
    expect(resolveDeletionDegree("file", "knowledge_and_file")?.deletesStorage).toBe(true);
    expect(resolveDeletionDegree("archive", "everything")?.deletesRecord).toBe(true);
  });

  it("rejects a degree that belongs to the other target", () => {
    // 'everything' is an archive-only depth; a file must not accept it.
    expect(resolveDeletionDegree("file", "everything")).toBeNull();
    // 'knowledge_and_file' is file-only.
    expect(resolveDeletionDegree("archive", "knowledge_and_file")).toBeNull();
  });

  it("rejects unknown / empty values", () => {
    expect(resolveDeletionDegree("file", "")).toBeNull();
    expect(resolveDeletionDegree("file", null)).toBeNull();
    expect(resolveDeletionDegree("archive", "nuke")).toBeNull();
    expect(isDeletionDegree("file", "nuke")).toBe(false);
    expect(isDeletionDegree("archive", 42)).toBe(false);
    expect(isDeletionDegree("archive", "everything")).toBe(true);
  });
});

describe("graded deletion — confirmation prompts", () => {
  it("describes a knowledge-only file deletion as reversible (file kept)", () => {
    const prompt = describeDeletion("file", "knowledge", 1);
    expect(prompt?.irreversible).toBe(false);
    expect(prompt?.requiresTypedConfirmation).toBe(false);
    expect(prompt?.summary).toMatch(/kept and can be ingested again/i);
  });

  it("marks a storage deletion irreversible but not typed-confirmation", () => {
    const prompt = describeDeletion("file", "knowledge_and_file", 1);
    expect(prompt?.irreversible).toBe(true);
    expect(prompt?.requiresTypedConfirmation).toBe(false);
    expect(prompt?.summary).toMatch(/cannot be undone/i);
  });

  it("requires typed confirmation only for the whole-import deletion", () => {
    const everything = describeDeletion("archive", "everything", 12);
    expect(everything?.requiresTypedConfirmation).toBe(true);
    expect(everything?.summary).toContain("12 files");
    expect(DELETION_CONFIRMATION_WORD).toBe("DELETE");

    const storage = describeDeletion("archive", "knowledge_and_files", 12);
    expect(storage?.requiresTypedConfirmation).toBe(false);
    expect(storage?.irreversible).toBe(true);
  });

  it("pluralizes the file count honestly", () => {
    expect(describeDeletion("archive", "everything", 1)?.summary).toContain("1 file,");
    expect(describeDeletion("archive", "everything", 3)?.summary).toContain("3 files");
  });

  it("returns null for an invalid degree", () => {
    expect(describeDeletion("file", "everything")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Who may delete ingested files.
//
// This predicate is the UI's mirror of the server guard in the
// ingestion_delete_* RPCs. If the two ever disagree the UI either hides a
// button that would work, or offers one that always fails — so the role sets
// are pinned here AND in src/lib/security/deletion-sql.test.ts.
// ---------------------------------------------------------------------------

describe("ingestion deletion authorization", () => {
  it("keeps the original organization roles unchanged", () => {
    // These are the roles 20260928 allowed. The 20260930 change ADDED a
    // platform role; it must not have quietly narrowed these.
    expect([...INGESTION_DELETE_ORG_ROLES]).toEqual(["owner", "admin", "manager"]);
  });

  it.each(["owner", "admin", "manager"])("allows an organization %s", (role) => {
    expect(canDeleteIngestedFiles({ memberRole: role })).toBe(true);
    expect(canDeleteIngestedFiles({ platformRole: null, memberRole: role })).toBe(true);
  });

  it.each(["analyst", "viewer", "customer_user", "", "Owner", "ADMIN"])(
    "refuses %s even if it merely looks like a privileged role",
    (role) => {
      // Role strings are compared exactly: a capitalized or padded value is
      // not a role, and must not be treated as one.
      expect(canDeleteIngestedFiles({ memberRole: role })).toBe(false);
    },
  );

  it("allows a platform super_admin with no membership at all", () => {
    // The case the 20260930 migration exists for: a super_admin is not a
    // member of most organizations.
    expect(INGESTION_DELETE_PLATFORM_ROLE).toBe("super_admin");
    expect(canDeleteIngestedFiles({ platformRole: "super_admin", memberRole: null })).toBe(true);
    expect(canDeleteIngestedFiles({ platformRole: "super_admin" })).toBe(true);
  });

  it("does NOT widen to other platform roles", () => {
    // atlas_admin is an internal operator role, not a super_admin. It must not
    // inherit the ability to delete another organization's ingested data.
    expect(canDeleteIngestedFiles({ platformRole: "atlas_admin", memberRole: null })).toBe(false);
    expect(canDeleteIngestedFiles({ platformRole: "customer_user", memberRole: null })).toBe(false);
  });

  it("refuses an anonymous viewer", () => {
    expect(canDeleteIngestedFiles({})).toBe(false);
    expect(canDeleteIngestedFiles({ platformRole: null, memberRole: null })).toBe(false);
  });

  it("explains the refusal instead of returning a bare false", () => {
    expect(ingestionDeleteDeniedReason({ memberRole: "analyst" })).toContain(
      "owners, admins and managers",
    );
    expect(ingestionDeleteDeniedReason({ memberRole: "owner" })).toBeNull();
    expect(ingestionDeleteDeniedReason({ platformRole: "super_admin" })).toBeNull();
  });
});
