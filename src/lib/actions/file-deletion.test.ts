// Graded deletion must never report a byte deletion that did not happen.
//
// The database rows and the Storage objects are two different systems: the RPC
// deletes rows, the client removes objects. When an operator picks a depth that
// destroys the original bytes and Storage refuses, the rows are already gone
// and the file is orphaned with nothing pointing at it. Reporting success
// would leave someone believing destroyed data was destroyed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteIngestedFileClient, deleteIngestedArchiveClient } from "./file-deletion";

const remove = vi.fn(async () => ({ data: [{ id: "x" }], error: null as { message: string } | null }));
const rpc = vi.fn(async () => ({}) as unknown);

vi.mock("@/lib/supabase", () => ({
  getSupabaseClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
    storage: { from: () => ({ remove }) },
  }),
  resolvedSupabaseUrl: "https://example.supabase.co",
}));

vi.mock("@/lib/actions/rpc", () => ({
  rpcCall: (...args: unknown[]) => (rpc as (...a: unknown[]) => unknown)(...args),
}));

beforeEach(() => {
  remove.mockClear();
  rpc.mockReset();
});

describe("graded deletion — Storage/DB consistency", () => {
  it("reports a successful byte deletion when Storage removes the object", async () => {
    rpc.mockResolvedValue({ documentsDeleted: 1, storagePath: "t1/f1" });
    const res = await deleteIngestedFileClient({ fileId: "f1", degree: "knowledge_and_file" });

    expect(res.storageRemoved).toBe(1);
    expect(res.storageRemovalFailed).toBe(false);
    expect(remove).toHaveBeenCalledWith(["t1/f1"]);
  });

  it("flags the partial deletion when Storage refuses, even though the rows are gone", async () => {
    remove.mockResolvedValueOnce({ data: null, error: { message: "new row violates row-level security policy" } });
    rpc.mockResolvedValue({ documentsDeleted: 1, storagePath: "t1/f1" });

    const res = await deleteIngestedFileClient({ fileId: "f1", degree: "knowledge_and_file" });

    // The knowledge deletion still happened — the RPC is not rolled back.
    expect(res.documentsDeleted).toBe(1);
    expect(res.ok).toBe(true);
    // ...but the caller is told the bytes survived, so the UI can warn.
    expect(res.storageRemoved).toBe(0);
    expect(res.storageRemovalFailed).toBe(true);
  });

  it("does not flag a knowledge-only deletion, which has no storage step", async () => {
    rpc.mockResolvedValue({ documentsDeleted: 1, storagePath: null });
    const res = await deleteIngestedFileClient({ fileId: "f1", degree: "knowledge" });

    expect(res.storageRemovalFailed).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("flags a whole-import deletion whose stored files survived", async () => {
    remove.mockResolvedValue({ data: null, error: { message: "policy" } });
    rpc.mockResolvedValue({
      documentsDeleted: 3,
      files: 3,
      storagePaths: ["t1/a", "t1/b"],
      archiveDeleted: false,
    });

    const res = await deleteIngestedArchiveClient({ archiveId: "a1", degree: "knowledge_and_files" });

    expect(res.storageRemoved).toBe(0);
    expect(res.storageRemovalFailed).toBe(true);
    expect(res.recordDeleted).toBe(false);
  });

  it("does not flag an archive deletion that removed every stored file", async () => {
    remove.mockResolvedValue({ data: [{ id: "a" }, { id: "b" }], error: null });
    rpc.mockResolvedValue({
      documentsDeleted: 3,
      files: 2,
      storagePaths: ["t1/a", "t1/b"],
      archiveDeleted: false,
    });

    const res = await deleteIngestedArchiveClient({ archiveId: "a1", degree: "knowledge_and_files" });

    expect(res.storageRemoved).toBe(2);
    expect(res.storageRemovalFailed).toBe(false);
  });

  it("does not flag a knowledge-only archive deletion", async () => {
    rpc.mockResolvedValue({ documentsDeleted: 3, files: 3, storagePaths: [], archiveDeleted: false });
    const res = await deleteIngestedArchiveClient({ archiveId: "a1", degree: "knowledge" });

    expect(res.storageRemovalFailed).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects a degree the server does not implement, before any request", async () => {
    await expect(
      deleteIngestedFileClient({ fileId: "f1", degree: "everything" as never }),
    ).rejects.toThrow(/Unsupported deletion depth/);
    expect(rpc).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
