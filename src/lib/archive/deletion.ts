// ---------------------------------------------------------------------------
// Atlas — graded deletion of ingested files and archives
//
// An ingestion upload can be removed at several DEPTHS, and the difference
// matters: deleting the Atlas knowledge document is not the same as also
// destroying the original uploaded bytes, which is not the same as removing
// the upload record entirely. This module is the single, testable description
// of those depths; the UI builds its confirmation prompt from it and the
// server enforces the matching scope string.
//
// Nothing here touches the network. The keys stay stable because they are sent
// to the server as the deletion scope.
// ---------------------------------------------------------------------------

export type DeletionTarget = "file" | "archive";

export type FileDeletionDegree = "knowledge" | "knowledge_and_file";
export type ArchiveDeletionDegree = "knowledge" | "knowledge_and_files" | "everything";

/** What a degree actually removes. */
export interface DeletionDegreeSpec {
  degree: string;
  /** Short label for the radio option. */
  label: string;
  /** One-sentence explanation shown under the label. */
  description: string;
  /** Deletes the original uploaded bytes from object storage. */
  deletesStorage: boolean;
  /** Deletes the upload record itself (the file row, or the whole archive). */
  deletesRecord: boolean;
  /** Broad and irreversible — the prompt marks it as such. */
  destructive: boolean;
}

/** A single ingested file inside an archive (or a standalone upload). */
export const FILE_DELETION_DEGREES: readonly DeletionDegreeSpec[] = [
  {
    degree: "knowledge",
    label: "Remove from knowledge only",
    description:
      "Deletes the Atlas document and its extracted content. The original file and its place in the import are kept, so it can be re-ingested later.",
    deletesStorage: false,
    deletesRecord: false,
    destructive: false,
  },
  {
    degree: "knowledge_and_file",
    label: "Remove from knowledge and delete the stored file",
    description:
      "Deletes the Atlas document AND the original uploaded file from storage. The import keeps a record that the file was deleted.",
    deletesStorage: true,
    deletesRecord: false,
    destructive: true,
  },
] as const;

/** An archive (zip) as uploaded, with all of its member files. */
export const ARCHIVE_DELETION_DEGREES: readonly DeletionDegreeSpec[] = [
  {
    degree: "knowledge",
    label: "Remove from knowledge only",
    description:
      "Deletes every Atlas document this import produced. The archive, its file inventory and every stored file are kept.",
    deletesStorage: false,
    deletesRecord: false,
    destructive: false,
  },
  {
    degree: "knowledge_and_files",
    label: "Remove from knowledge and delete stored files",
    description:
      "Deletes every document AND every stored member file. The import record is kept so you can see what was removed.",
    deletesStorage: true,
    deletesRecord: false,
    destructive: true,
  },
  {
    degree: "everything",
    label: "Delete the entire import",
    description:
      "Deletes every document, every stored file, and the import record itself. Nothing is retained — this cannot be undone.",
    deletesStorage: true,
    deletesRecord: true,
    destructive: true,
  },
] as const;

/** Every valid degree string across both targets. */
export const ALL_DELETION_DEGREES: readonly string[] = [
  ...new Set([
    ...FILE_DELETION_DEGREES.map((d) => d.degree),
    ...ARCHIVE_DELETION_DEGREES.map((d) => d.degree),
  ]),
];

/** The degrees available for a target, in the order they should be shown. */
export function deletionDegreesFor(target: DeletionTarget): readonly DeletionDegreeSpec[] {
  return target === "archive" ? ARCHIVE_DELETION_DEGREES : FILE_DELETION_DEGREES;
}

/** Resolve a degree to its spec, or null when it is not valid for the target. */
export function resolveDeletionDegree(
  target: DeletionTarget,
  degree: string | null | undefined,
): DeletionDegreeSpec | null {
  if (!degree) return null;
  return deletionDegreesFor(target).find((d) => d.degree === degree) ?? null;
}

/** True when `degree` is one of the degrees allowed for `target`. */
export function isDeletionDegree(target: DeletionTarget, degree: unknown): boolean {
  return typeof degree === "string" && resolveDeletionDegree(target, degree) !== null;
}

export interface DeletionPrompt {
  title: string;
  /** The irreversible consequence, stated plainly. */
  summary: string;
  /** True when the degree destroys data and cannot be reversed. */
  irreversible: boolean;
  /**
   * True when the operator must type a confirmation word, reserved for the
   * broadest, record-destroying action.
   */
  requiresTypedConfirmation: boolean;
}

/**
 * Build the confirmation prompt for a deletion. `count` is the number of
 * files the operation will touch (used to make the impact concrete).
 */
export function describeDeletion(
  target: DeletionTarget,
  degree: string,
  count = 1,
): DeletionPrompt | null {
  const spec = resolveDeletionDegree(target, degree);
  if (!spec) return null;

  const scope = target === "archive" ? "this import" : "this file";
  const files = `${count} file${count === 1 ? "" : "s"}`;

  if (!spec.deletesStorage && !spec.deletesRecord) {
    return {
      title: target === "archive" ? "Remove this import from knowledge?" : "Remove this file from knowledge?",
      summary: `Atlas will delete the ingested knowledge for ${scope} (${target === "archive" ? files : "the extracted document and chunks"}). The original uploaded file${target === "archive" ? "s are" : " is"} kept and can be ingested again.`,
      irreversible: false,
      requiresTypedConfirmation: false,
    };
  }

  if (!spec.deletesRecord) {
    return {
      title: target === "archive" ? "Delete this import's knowledge and stored files?" : "Delete this file and its stored content?",
      summary: `Atlas will delete the ingested knowledge for ${scope} and permanently remove ${target === "archive" ? `all ${files}` : "the original uploaded file"} from storage. The import record stays so you can see what was removed. This cannot be undone.`,
      irreversible: true,
      requiresTypedConfirmation: false,
    };
  }

  return {
    title: "Delete this entire import?",
    summary: `Atlas will permanently delete the ingested knowledge, all ${files}, and the import record itself. Nothing is retained. This cannot be undone.`,
    irreversible: true,
    requiresTypedConfirmation: true,
  };
}

/** The word an operator must type to confirm a record-destroying deletion. */
export const DELETION_CONFIRMATION_WORD = "DELETE";

// ---------------------------------------------------------------------------
// Who may delete
//
// This mirrors the server guard in the ingestion_delete_* RPCs exactly. The
// server is the security boundary — this only keeps the button from appearing
// for people the server would reject, which would otherwise be a button that
// always fails.
//
// The two sources are deliberately different: an ORGANIZATION role (from the
// caller's own membership) and a PLATFORM role (Atlas-wide). A platform
// super_admin administers every organization and is not a member of most of
// them, which is exactly why the server had to resolve the tenant from the
// target row for them.
// ---------------------------------------------------------------------------

/** Organization roles that may delete ingested data. Unchanged since 20260928. */
export const INGESTION_DELETE_ORG_ROLES = ["owner", "admin", "manager"] as const;

/** The platform role that may delete ingested data in ANY organization. */
export const INGESTION_DELETE_PLATFORM_ROLE = "super_admin";

export interface IngestionDeleteViewer {
  /** `platform_role` from the caller's profile. */
  platformRole?: string | null;
  /** The caller's role in the organization that owns the file. */
  memberRole?: string | null;
}

/**
 * True when this viewer may delete ingested files.
 *
 * A platform super_admin passes regardless of membership; everyone else must
 * hold one of the organization roles above.
 */
export function canDeleteIngestedFiles(viewer: IngestionDeleteViewer): boolean {
  if (viewer.platformRole === INGESTION_DELETE_PLATFORM_ROLE) return true;
  return INGESTION_DELETE_ORG_ROLES.includes(
    viewer.memberRole as (typeof INGESTION_DELETE_ORG_ROLES)[number],
  );
}

/** Why the delete control is unavailable, for the UI to explain itself. */
export function ingestionDeleteDeniedReason(viewer: IngestionDeleteViewer): string | null {
  if (canDeleteIngestedFiles(viewer)) return null;
  return "Only organization owners, admins and managers — or an Atlas super admin — can delete ingested files.";
}
