// ---------------------------------------------------------------------------
// Client-side graded deletion for ingested files and archives.
//
// Two halves, matching the two stores Atlas uses:
//   * Postgres (knowledge + upload records) via SECURITY-scoped RPCs that
//     authorize the caller by tenant + role and audit every deletion.
//   * Supabase Storage (the original uploaded bytes) via the Storage API,
//     because deleting a ``storage.objects`` row in SQL would orphan the
//     backing object.
//
// The RPC returns the storage path(s) that should be removed for the chosen
// depth; this module removes them and reports the result honestly.
// ---------------------------------------------------------------------------

import { getSupabaseClient } from "@/lib/supabase";
import { rpcCall } from "@/lib/actions/rpc";
import {
  isDeletionDegree,
  type ArchiveDeletionDegree,
  type FileDeletionDegree,
} from "@/lib/archive/deletion";

export interface DeletionResult {
  ok: boolean;
  documentsDeleted: number;
  filesAffected: number;
  storageRemoved: number;
  recordDeleted: boolean;
}

const DOCUMENTS_BUCKET = "documents";

/**
 * Delete one ingested file to the chosen depth.
 *
 * `knowledge`               → delete the Atlas document + chunks only.
 * `knowledge_and_file`      → also delete the original stored file.
 */
export async function deleteIngestedFileClient(args: {
  fileId: string;
  degree: FileDeletionDegree;
}): Promise<DeletionResult> {
  if (!args.fileId) throw new Error("A file is required.");
  if (!isDeletionDegree("file", args.degree)) {
    throw new Error(`Unsupported deletion depth: ${args.degree}`);
  }

  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const res = (await rpcCall(supabase, "ingestion_delete_archive_file", {
    fileId: args.fileId,
    scope: args.degree,
  })) as { documentsDeleted?: number; storagePath?: string | null } | null;

  let storageRemoved = 0;
  const storagePath = res?.storagePath ?? null;
  if (storagePath) {
    const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath]);
    if (!error) storageRemoved = 1;
  }

  return {
    ok: true,
    documentsDeleted: res?.documentsDeleted ?? 0,
    filesAffected: 1,
    storageRemoved,
    recordDeleted: false,
  };
}

/**
 * Delete an ingested archive to the chosen depth.
 *
 * `knowledge`          → delete every Atlas document it produced.
 * `knowledge_and_files`→ also delete every stored member file.
 * `everything`         → also delete the import record and its inventory.
 */
export async function deleteIngestedArchiveClient(args: {
  archiveId: string;
  degree: ArchiveDeletionDegree;
}): Promise<DeletionResult> {
  if (!args.archiveId) throw new Error("An archive is required.");
  if (!isDeletionDegree("archive", args.degree)) {
    throw new Error(`Unsupported deletion depth: ${args.degree}`);
  }

  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const res = (await rpcCall(supabase, "ingestion_delete_archive", {
    archiveId: args.archiveId,
    scope: args.degree,
  })) as {
    documentsDeleted?: number;
    files?: number;
    storagePaths?: string[];
    archiveDeleted?: boolean;
  } | null;

  const paths = (res?.storagePaths ?? []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );

  let storageRemoved = 0;
  if (paths.length > 0) {
    // Remove in bounded batches so a very large import stays within one call.
    const BATCH = 100;
    for (let i = 0; i < paths.length; i += BATCH) {
      const slice = paths.slice(i, i + BATCH);
      const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).remove(slice);
      if (!error) storageRemoved += data?.length ?? slice.length;
    }
  }

  return {
    ok: true,
    documentsDeleted: res?.documentsDeleted ?? 0,
    filesAffected: res?.files ?? 0,
    storageRemoved,
    recordDeleted: Boolean(res?.archiveDeleted),
  };
}
