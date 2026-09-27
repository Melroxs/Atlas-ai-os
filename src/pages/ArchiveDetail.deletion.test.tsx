// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Toaster } from "sonner";

const actionFn = vi.fn(async () => ({
  ok: true,
  documentsDeleted: 1,
  filesAffected: 1,
  storageRemoved: 1,
  recordDeleted: false,
}));

vi.mock("@/hooks/use-supabase", () => ({
  useQuery: vi.fn(),
  useAction: vi.fn(() => actionFn),
  useMutation: vi.fn(() => vi.fn(async () => ({ ok: true }))),
  invalidateQueries: vi.fn(),
}));

vi.mock("react-router", () => ({
  useParams: () => ({ id: "arch-1" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    archive: {
      getArchiveDetail: {},
      cancelArchive: {},
      beginProcessing: {},
      retryFiles: {},
      deleteArchiveWithDegree: {},
      deleteIngestedFile: {},
    },
  },
}));

import { useQuery } from "@/hooks/use-supabase";
import ArchiveDetail from "./ArchiveDetail";

const DETAIL = {
  archive: {
    _id: "arch-1",
    filename: "Claims.zip",
    fileType: "zip",
    status: "completed",
    progress: 100,
    checksum: "abcdef0123456789abcdef",
    fileCount: 1,
    compressedSize: 2048,
    extractedSize: 8192,
    createdAt: Date.now(),
    completedAt: Date.now(),
    rawRetained: true,
    failureReason: null,
    warnings: [],
    stats: { ingested: 1, failed: 0, duplicates: 0, unsupported: 0, blocked: 0, tooLarge: 0, classifications: {}, potentialClaims: [] },
  },
  files: [
    {
      _id: "file-1",
      path: "claims/estimate.pdf",
      filename: "estimate.pdf",
      mimeType: "application/pdf",
      size: 4096,
      storageId: "storage/file-1",
      documentId: "doc-1",
      ingestStatus: "ingested",
      classification: "estimate",
      isDuplicate: false,
      duplicateOfPath: null,
      isSuperseded: false,
      supersedesPath: null,
      versionGroup: null,
      claimHints: [],
      error: null,
      blockReason: null,
    },
  ],
  docs: {
    "doc-1": { _id: "doc-1", title: "estimate.pdf", classification: "estimate", status: "ready" },
  },
  candidates: [],
};

describe("ArchiveDetail — graded deletion UI", () => {
  beforeEach(() => {
    actionFn.mockClear();
    vi.mocked(useQuery).mockReturnValue(DETAIL as never);
  });
  afterEach(() => cleanup());

  it("offers a depth choice and deletes a single file at the chosen depth", async () => {
    render(
      <>
        <ArchiveDetail />
        <Toaster />
      </>,
    );

    // Per-file delete button appears for an ingested file that has storage.
    const fileDelete = await screen.findByTitle("Delete this ingested file");
    fireEvent.click(fileDelete);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete file")).toBeInTheDocument();
    // Both depths are offered for a file with stored bytes.
    expect(
      within(dialog).getByText("Remove from knowledge only"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Remove from knowledge and delete the stored file"),
    ).toBeInTheDocument();

    // Choose the storage depth, then confirm.
    fireEvent.click(
      within(dialog).getByText("Remove from knowledge and delete the stored file"),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(actionFn).toHaveBeenCalledWith({
        fileId: "file-1",
        degree: "knowledge_and_file",
      }),
    );
  });

  it("requires typing DELETE before removing the entire import", async () => {
    render(
      <>
        <ArchiveDetail />
        <Toaster />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Delete import/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete import")).toBeInTheDocument();

    // The whole-import depth is offered and is the only record-destroying one.
    const everything = within(dialog).getByText("Delete the entire import");
    expect(everything).toBeInTheDocument();
    fireEvent.click(everything);

    // Confirmation is blocked until the word is typed.
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Type DELETE to confirm/), {
      target: { value: "DELETE" },
    });
    await waitFor(() => expect(confirm).not.toBeDisabled());

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(actionFn).toHaveBeenCalledWith({
        archiveId: "arch-1",
        degree: "everything",
      }),
    );
  });
});
