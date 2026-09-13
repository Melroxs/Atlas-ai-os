import { api } from "@/lib/api";
import ArchiveUpload from "@/components/archive-upload";
import {
  ArchiveStatusBadge,
  ClassificationBadge,
  DocStatusBadge,
  EmptyPanel,
  PageHeader,
  formatBytes,
  formatDate,
} from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAction, useMutation, useQuery } from "@/hooks/use-supabase";
import { uploadToStorage } from "@/lib/actions/upload";
import { normalizeArchiveStats } from "@/lib/actions/normalize";
import { ACCEPTED_EXTENSIONS, classifyFile } from "@/lib/ingest/formats";
import { describeIngestionError } from "@/lib/ingest/errors";
import {
  Archive,
  CheckCircle2,
  Database,
  FileText,
  FileUp,
  FlaskConical,
  Loader2,
  Radar,
  Search,
  ShieldCheck,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { filterBySearch, paginate, totalPages } from "@/lib/workforce/selectors";

export default function Knowledge() {
  const navigate = useNavigate();
  const workspace = useQuery(api.tenants.getMyWorkspace);
  const docs = useQuery(api.documents.listDocuments);
  const stats = useQuery(api.documents.documentStats);
  const processDocument = useAction(api.ingestion.processDocument);
  const seedDemo = useMutation(api.seed.seedDemoData);
  const runDetectors = useAction(api.recommendations.runDetectors);
  const archives = useQuery(api.archive.listArchives);
  const archiveStatsRaw = useQuery(api.archive.archiveStats);
  // archive_stats contract: null/failed → honest zero-shape; valid → numbers.
  const archiveStats = useMemo(() => normalizeArchiveStats(archiveStatsRaw), [archiveStatsRaw]);

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [docQuery, setDocQuery] = useState("");
  const [docPage, setDocPage] = useState(1);
  const [uploads, setUploads] = useState<
    Array<{
      id: string;
      name: string;
      state: "uploading" | "processing" | "ready" | "failed";
      detail?: string;
    }>
  >([]);
  const isViewer = workspace?.membership?.role === "viewer";

  const patchUpload = (id: string, patch: Partial<(typeof uploads)[number]>) =>
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const incoming = Array.from(files);
    setUploading(true);
    let ok = 0;
    let failed = 0;
    for (const file of incoming) {
      const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setUploads((prev) => [...prev, { id, name: file.name, state: "uploading" }]);
      try {
        // Canonical format contract decides BEFORE anything is stored.
        const info = classifyFile(file.name, file.type, null);
        if (!info.supported) {
          throw new Error(info.reason ?? "Unsupported file type.");
        }
        if (info.kind === "archive") {
          throw new Error(
            "ZIP/RAR archives must be uploaded through the Company data archive importer, not as individual documents.",
          );
        }
        patchUpload(id, { state: "processing" });
        const { storageId } = await uploadToStorage({
          bytes: file,
          mimeType: file.type,
        });
        await processDocument({
          storageId: storageId as never,
          title: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          sourceType: "upload",
        });
        patchUpload(id, { state: "ready" });
        ok++;
      } catch (e) {
        console.error("Upload failed:", e);
        const info = describeIngestionError(e);
        patchUpload(id, { state: "failed", detail: `${info.message} ${info.next}`.trim() });
        failed++;
      }
    }
    setUploading(false);
    if (failed > 0) {
      toast.error(`${failed} file${failed === 1 ? "" : "s"} could not be processed`, {
        description: "See the per-file results below for what failed and why.",
      });
    } else if (ok > 0) {
      toast.success(`${ok} document${ok === 1 ? "" : "s"} became Atlas knowledge`, {
        description: "Extracted text, chunks, entities and evidence are now searchable.",
      });
      try {
        await runDetectors();
      } catch {
        // detectors are best-effort after upload
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void handleFiles(e.dataTransfer.files);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const onDragLeave = useCallback(() => setDragging(false), []);

  const handleSeed = async () => {
    setSeeding(true);
    try {
      const res = await seedDemo();
      if (res.seeded) {
        toast.success("Demo knowledge loaded", {
          description: `${res.documents} documents · ${res.entities} entities · ${res.assertions} assertions`,
        });
        await runDetectors();
      } else {
        toast.info("Demo knowledge already exists");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load demo data");
    } finally {
      setSeeding(false);
    }
  };

  const total = stats?.total ?? 0;

  return (
    <div
      className="flex flex-col gap-6"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <PageHeader
        eyebrow="Knowledge base"
        title="Everything Atlas knows"
        description="Upload the documents that describe how your company works — SOPs, policies, invoices, estimates, spreadsheets."
        actions={
          !isViewer ? (
            <>
              <Button
                variant="outline"
                onClick={handleSeed}
                disabled={seeding || uploading}
                className="gap-2"
              >
                {seeding ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FlaskConical className="size-4 text-teal-600 dark:text-teal-600 dark:text-teal-300" />
                )}
                Load demo
              </Button>
              <Button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="gap-2"
              >
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FileUp className="size-4" />
                )}
                {uploading ? "Uploading…" : "Upload documents"}
              </Button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ACCEPTED_EXTENSIONS}
                className="hidden"
                onChange={(e) => void handleFiles(e.target.files)}
              />
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 text-teal-600 dark:text-teal-600 dark:text-teal-300" />
              Viewers have read-only access
            </span>
          )
        }
      />

      {/* Individual file uploads — drag/drop + per-file results */}
      {!isViewer && (
        <div
          className={`rounded-xl border border-dashed transition-colors ${
            dragging
              ? "border-teal-400/60 bg-teal-400/5"
              : "border-border/70 bg-card/40"
          }`}
        >
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex w-full flex-col items-center justify-center gap-2 px-6 py-8 text-center"
          >
            <UploadCloud className="size-8 text-teal-600 dark:text-teal-300" />
            <p className="text-sm font-medium">
              {dragging ? "Drop files to upload" : "Upload company documents"}
            </p>
            <p className="max-w-md text-xs text-muted-foreground">
              PDF · Word (.docx) · Excel/CSV · Images · Text/Markdown · email
              (.eml). Drag files here or click to browse — every file becomes
              searchable Atlas knowledge.
            </p>
          </button>
          {uploads.length > 0 && (
            <div className="border-t border-border/50 px-5 py-3">
              <div className="flex flex-col gap-2">
                {uploads.map((u) => (
                  <div key={u.id} className="flex items-start gap-2.5 text-xs">
                    {u.state === "ready" && (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                    )}
                    {u.state === "failed" && (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-rose-500" />
                    )}
                    {(u.state === "uploading" || u.state === "processing") && (
                      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-teal-500" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{u.name}</p>
                      <p className="text-muted-foreground">
                        {u.state === "ready" && "Ready — now part of Atlas knowledge"}
                        {u.state === "uploading" && "Uploading to secure tenant storage…"}
                        {u.state === "processing" && "Extracting, understanding and indexing…"}
                        {u.state === "failed" && (u.detail ?? "Failed to process.")}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Company data archives — Phase 13 */}
      {!isViewer && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Archive className="size-4 text-amber-600 dark:text-amber-300" />
              <h2 className="text-sm font-semibold">Company data archives</h2>
              {archiveStats && archiveStats.total > 0 && (
                <span className="font-mono text-xs text-muted-foreground">
                  {archiveStats.total} archive{archiveStats.total === 1 ? "" : "s"}
                  {archiveStats.filesIngested > 0
                    ? ` · ${archiveStats.filesIngested.toLocaleString()} files ingested`
                    : ""}
                  {archiveStats.potentialClaims > 0
                    ? ` · ${archiveStats.potentialClaims} potential claim${archiveStats.potentialClaims === 1 ? "" : "s"}`
                    : ""}
                </span>
              )}
            </div>
          </div>

          <ArchiveUpload />

          {(archives ?? []).length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
              <div className="divide-y divide-border/50">
                {(archives ?? []).map((a) => {
                  const st = a.stats as Record<string, unknown> | null | undefined;
                  const ingested = typeof st?.ingested === "number" ? st.ingested : 0;
                  const totalFiles = typeof st?.totalFiles === "number" ? st.totalFiles : a.fileCount;
                  const pct =
                    a.status === "completed" ||
                    a.status === "completed_with_warnings" ||
                    a.status === "failed" ||
                    a.status === "cancelled"
                      ? 1
                      : totalFiles > 0
                        ? Math.min(0.99, a.progress)
                        : 0;
                  return (
                    <button
                      key={a._id}
                      type="button"
                      onClick={() =>
                        navigate(`/dashboard/knowledge/archives/${a._id}`)
                      }
                      className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/40"
                    >
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-400/10 text-amber-600 dark:text-amber-300 ring-1 ring-amber-400/20">
                        <Archive className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {a.filename}
                        </p>
                        <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{formatBytes(a.compressedSize)}</span>
                          <span>·</span>
                          <span>
                            {totalFiles.toLocaleString()} files ·{" "}
                            {ingested.toLocaleString()} ingested
                          </span>
                          {a.warnings.length > 0 && (
                            <>
                              <span>·</span>
                              <span className="text-amber-600 dark:text-amber-300">
                                {a.warnings.length} warning{a.warnings.length === 1 ? "" : "s"}
                              </span>
                            </>
                          )}
                        </p>
                        {!["completed", "completed_with_warnings", "failed", "cancelled"].includes(
                          a.status,
                        ) && (
                          <div className="mt-2 h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-teal-500 transition-all"
                              style={{ width: `${Math.round(pct * 100)}%` }}
                            />
                          </div>
                        )}
                      </div>
                      <div className="hidden shrink-0 items-center gap-2 sm:flex">
                        {a.status === "completed_with_warnings" && (
                          <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300">
                            review warnings
                          </Badge>
                        )}
                        <ArchiveStatusBadge status={a.status} />
                      </div>
                      <div className="hidden shrink-0 font-mono text-[11px] text-muted-foreground/60 md:block">
                        {formatDate(a.createdAt)}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Pipeline status */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-mono uppercase tracking-wider text-muted-foreground">
          <Radar className="size-3.5 text-teal-600 dark:text-teal-300" />
          Pipeline
        </span>
        <span className="rounded-full border border-border/70 bg-card/60 px-2.5 py-1 text-muted-foreground">
          {total} total
        </span>
        <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-emerald-600 dark:text-emerald-300">
          {stats?.ready ?? 0} ready
        </span>
        {(stats?.processing ?? 0) > 0 && (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-amber-600 dark:text-amber-300">
            {stats?.processing ?? 0} processing
          </span>
        )}
        {(stats?.failed ?? 0) > 0 && (
          <span className="rounded-full border border-rose-400/30 bg-rose-400/10 px-2.5 py-1 text-rose-600 dark:text-rose-300">
            {stats?.failed ?? 0} failed
          </span>
        )}
        <span className="text-muted-foreground/70">{stats?.chunks ?? 0} chunks</span>
      </div>

      {/* Document list — scalable: search + pagination over the collection */}
      {(docs ?? []).length === 0 ? (
        <EmptyPanel
          icon={Database}
          title="No documents yet"
          description="Atlas can parse PDFs, Word docs, plain text, CSV and spreadsheet files. Documents become the evidence behind every answer and recommendation."
          action={
            !isViewer ? (
              <div className="flex gap-2">
                <Button onClick={() => fileRef.current?.click()}>
                  <FileUp className="mr-2 size-4" />
                  Upload your first documents
                </Button>
                <Button variant="outline" onClick={handleSeed} disabled={seeding}>
                  <FlaskConical className="mr-2 size-4" />
                  {seeding ? "Loading…" : "Load demo knowledge"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Ask a manager or analyst to upload documents for this workspace.
              </p>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={docQuery}
                onChange={(e) => {
                  setDocQuery(e.target.value);
                  setDocPage(1);
                }}
                placeholder="Search documents…"
                className="h-8 pl-8 text-xs"
                aria-label="Search documents"
              />
            </div>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {docs?.length.toLocaleString() ?? 0} document{(docs?.length ?? 0) === 1 ? "" : "s"}
            </span>
          </div>
          {(() => {
            const filteredDocs = filterBySearch(docs ?? [], docQuery, [
              (d) => d.title,
              (d) => String(d.classification ?? ""),
              (d) => String(d.summary ?? ""),
            ]);
            const pages = totalPages(filteredDocs.length, 25);
            const pageDocs = paginate(filteredDocs, Math.min(docPage, pages), 25);
            return (
              <>
                {pageDocs.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/70 px-6 py-8 text-center text-sm text-muted-foreground">
                    No documents match “{docQuery}”.
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
                    <div className="divide-y divide-border/50">
                      {pageDocs.map((d) => (
                        <button
                          key={d._id}
                          type="button"
                          onClick={() => navigate(`/dashboard/knowledge/${d._id}`)}
                          className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/40"
                        >
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-400/10 text-teal-600 dark:text-teal-300 ring-1 ring-teal-400/20">
                            <FileText className="size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{d.title}</p>
                            <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{formatBytes(d.size)}</span>
                              <span>·</span>
                              <span>{d.chunkCount ?? 0} chunks</span>
                              <span>·</span>
                              <span>{d.entityCount ?? 0} entities</span>
                            </p>
                          </div>
                          <div className="hidden shrink-0 items-center gap-2 sm:flex">
                            <ClassificationBadge classification={d.classification} />
                            <DocStatusBadge status={d.status ?? "unknown"} />
                            {d.externalDeletedAt ? (
                              <span className="rounded-md border border-rose-400/30 bg-rose-400/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-rose-600 dark:text-rose-300">
                                removed from source
                              </span>
                            ) : null}
                          </div>
                          <div className="hidden shrink-0 font-mono text-[11px] text-muted-foreground/60 md:block">
                            {formatDate(d.processedAt ?? d._creationTime)}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {pages > 1 && (
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                      Page {Math.min(docPage, pages)} of {pages}
                    </p>
                    <div className="flex gap-1.5">
                      <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={docPage <= 1} onClick={() => setDocPage((p) => Math.max(1, p - 1))}>
                        Previous
                      </Button>
                      <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={docPage >= pages} onClick={() => setDocPage((p) => Math.min(pages, p + 1))}>
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
