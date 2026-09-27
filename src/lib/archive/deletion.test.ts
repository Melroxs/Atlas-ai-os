import { describe, it, expect } from "vitest";
import {
  ALL_DELETION_DEGREES,
  ARCHIVE_DELETION_DEGREES,
  DELETION_CONFIRMATION_WORD,
  FILE_DELETION_DEGREES,
  deletionDegreesFor,
  describeDeletion,
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
