// ---------------------------------------------------------------------------
// Atlas Blog — admin content pipeline (/dashboard/blog)
//
// Authorization is enforced SERVER-SIDE by content_admin_list /
// content_review_decide / content_publish_blog (in-function admin guard), not
// by this page. A non-admin sees the refusal the database returns.
//
// Nothing here generates content and nothing publishes without a prior human
// approval: the Approve action is what unlocks Publish.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { blogAdminApi, type AdminContentItem } from "@/lib/blog/admin-api";
import { siteOrigin } from "@/lib/blog/queries";
import { useMutation } from "@/hooks/use-supabase";

type AdminItem = AdminContentItem;

const STATUS_FILTERS = [
  "all",
  "opportunity",
  "researching",
  "drafted",
  "in_review",
  "approved",
  "published",
  "failed",
  "archived",
] as const;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  published: "default",
  approved: "secondary",
  failed: "destructive",
};

export default function BlogAdmin() {
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [items, setItems] = useState<AdminItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const listContent = useMutation<{ p_status?: string | null; p_limit?: number }, unknown>(
    blogAdminApi.contentAdminList,
  );
  const review = useMutation<{ p_content_id: string; p_decision: string; p_note?: string }, unknown>(
    blogAdminApi.contentReviewDecide,
  );
  const publish = useMutation<{ p_content_id: string; p_base_url?: string }, unknown>(
    blogAdminApi.contentPublishBlog,
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await listContent({
        p_status: filter === "all" ? null : filter,
        p_limit: 200,
      });
      setItems((Array.isArray(rows) ? rows : []) as AdminItem[]);
    } catch (e) {
      setItems([]);
      setError(
        e instanceof Error
          ? e.message
          : "The content pipeline could not be read. Admin access is required.",
      );
    }
  }, [filter, listContent]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, fn: () => Promise<unknown>, label: string) {
    setBusyId(id);
    setNote(null);
    setError(null);
    try {
      const result = (await fn()) as { ok?: boolean; error?: string; slug?: string } | null;
      if (result && result.ok === false) {
        setNote(`${label} failed: ${result.error ?? "unknown reason"}`);
      } else if (result && typeof result.slug === "string") {
        setNote(`${label} — published at /blog/${result.slug}`);
      } else {
        setNote(`${label} completed.`);
      }
      await load();
    } catch (e) {
      setNote(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Blog content pipeline
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Every article moves through opportunity → research → draft → review →
            approved → published. Publishing requires a human approval; automated
            publishing is off unless it is explicitly configured.
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link to="/blog" target="_blank" rel="noreferrer">
            View public blog
          </Link>
        </Button>
      </header>

      <div className="mt-5 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((status) => (
          <Button
            key={status}
            size="sm"
            variant={filter === status ? "default" : "outline"}
            onClick={() => setFilter(status)}
          >
            {status}
          </Button>
        ))}
      </div>

      {error ? (
        <p className="mt-6 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="mt-6 rounded-md border border-border bg-muted/30 p-4 text-sm text-foreground">
          {note}
        </p>
      ) : null}

      <div className="mt-6 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[52rem] text-left text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Article</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Approval</th>
              <th className="px-4 py-3">Body</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items === null ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={5}>
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={5}>
                  No content items in this state.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item._id} className="align-top">
                  <td className="px-4 py-4">
                    <p className="font-medium text-foreground">{item.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.contentType}
                      {item.slug ? ` · /blog/${item.slug}` : ""}
                    </p>
                    {item.failureReason ? (
                      <p className="mt-1 text-xs text-destructive">{item.failureReason}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-4">
                    <Badge variant={STATUS_VARIANT[item.status] ?? "outline"}>
                      {item.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-4 text-muted-foreground">{item.approvalStatus}</td>
                  <td className="px-4 py-4 text-muted-foreground">
                    {item.hasBody ? "yes" : "no"}
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === item._id}
                        onClick={() =>
                          void act(
                            item._id,
                            () => review({ p_content_id: item._id, p_decision: "in_review" }),
                            "Send to review",
                          )
                        }
                      >
                        Review
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === item._id}
                        onClick={() =>
                          void act(
                            item._id,
                            () => review({ p_content_id: item._id, p_decision: "approved" }),
                            "Approve",
                          )
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === item._id}
                        onClick={() =>
                          void act(
                            item._id,
                            () =>
                              review({
                                p_content_id: item._id,
                                p_decision: "needs_changes",
                                p_note: "Requested changes from the content pipeline.",
                              }),
                            "Request changes",
                          )
                        }
                      >
                        Changes
                      </Button>
                      <Button
                        size="sm"
                        disabled={busyId === item._id || item.status !== "approved"}
                        onClick={() =>
                          void act(
                            item._id,
                            () =>
                              publish({
                                p_content_id: item._id,
                                p_base_url: siteOrigin(),
                              }),
                            "Publish",
                          )
                        }
                      >
                        Publish
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        Scheduled generation, retries and distribution run through the durable Atlas job
        queue (atlas_jobs), never from this page. Failures recorded against an item stay
        visible here so they can be retried rather than silently dropped.
      </p>
    </div>
  );
}
