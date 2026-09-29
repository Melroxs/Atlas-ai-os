// ---------------------------------------------------------------------------
// Atlas Content Studio — dashboard (/dashboard/content)
//
// ONE IDEA -> ONE CONTENT PACKAGE -> BLOG + VIDEO + THUMBNAIL + LINKEDIN
//
// Authorization is enforced server-side (content_studio_list / content_engine_*
// re-derive the caller's organization); this page only renders what the database
// returns. Nothing here fabricates a status: a channel with no publication row
// reads "Not queued", never "published".
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  CheckCircle2,
  Clock,
  FileText,
  Image as ImageIcon,
  Linkedin,
  Loader2,
  Megaphone,
  Plus,
  RefreshCw,
  Youtube,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyPanel, PageHeader, StatCard, formatDate } from "@/components/atlas-ui";
import { contentStudio } from "@/lib/content-engine/studio-api";
import { DESTINATION_LABEL, type DestinationProvider } from "@/lib/content-engine/types";
import type { StudioPackageRow } from "@/lib/content-engine/client";

type Summary = Record<string, number>;

/** A destination's state for one package, from real rows only. */
function destinationStates(row: StudioPackageRow): Array<{
  provider: DestinationProvider;
  label: string;
  state: string;
  tone: "ok" | "wait" | "bad" | "idle";
  icon: typeof FileText;
}> {
  const pkg = row.package;
  const publication = (provider: DestinationProvider) =>
    row.publications.find((p) => p["provider"] === provider) ?? null;
  const asset = (contentType: string) =>
    row.assets.find((a) => a["contentType"] === contentType) ?? null;

  const fromPublication = (
    provider: DestinationProvider,
    fallback: string,
  ): { state: string; tone: "ok" | "wait" | "bad" | "idle" } => {
    const pub = publication(provider);
    if (!pub) return { state: fallback, tone: "idle" };
    const status = String(pub["status"] ?? "");
    if (status === "published") return { state: "Published", tone: "ok" };
    if (status === "failed") return { state: "Failed", tone: "bad" };
    if (status === "processing") return { state: "Publishing…", tone: "wait" };
    return { state: "Queued", tone: "wait" };
  };

  const blogReady = Boolean(asset("blog_article"));
  const videoAsset = asset("youtube_video");
  const thumbnail = asset("youtube_thumbnail");

  const blogState = pkg["slug"]
    ? pkg["status"] === "published"
      ? { state: "Published", tone: "ok" as const }
      : { state: "Ready", tone: "ok" as const }
    : blogReady
      ? { state: "Draft", tone: "wait" as const }
      : { state: "Not generated", tone: "idle" as const };

  const articleStatus = String(pkg["status"] ?? "");
  const blogTone =
    articleStatus === "failed"
      ? ("bad" as const)
      : articleStatus === "published"
        ? ("ok" as const)
        : blogState.tone;

  return [
    {
      provider: "blog",
      label: DESTINATION_LABEL.blog,
      state: articleStatus === "failed" ? "Failed" : blogState.state,
      tone: blogTone,
      icon: FileText,
    },
    {
      provider: "youtube",
      label: DESTINATION_LABEL.youtube,
      ...fromPublication("youtube", videoAsset ? "Rendered, not published" : "Not generated"),
      icon: Youtube,
    },
    {
      provider: "linkedin",
      label: DESTINATION_LABEL.linkedin,
      ...fromPublication("linkedin", asset("linkedin_post") ? "Draft ready" : "Not written"),
      icon: Linkedin,
    },
    {
      // The thumbnail is not a publishing destination; it reports the asset.
      provider: "blog",
      label: "Thumbnail",
      state: thumbnail ? "Generated" : "Not generated",
      tone: thumbnail ? ("ok" as const) : ("idle" as const),
      icon: ImageIcon,
    },
  ];
}

function toneClass(tone: "ok" | "wait" | "bad" | "idle"): string {
  if (tone === "ok") return "text-emerald-600 dark:text-emerald-400";
  if (tone === "wait") return "text-amber-600 dark:text-amber-400";
  if (tone === "bad") return "text-destructive";
  return "text-muted-foreground";
}

export default function ContentStudio() {
  const [rows, setRows] = useState<StudioPackageRow[] | null>(null);
  const [summary, setSummary] = useState<Summary>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [topic, setTopic] = useState("");
  const [open, setOpen] = useState(false);

  // The API is an EXTERNAL system, so the fetch is the effect's job and the
  // state is written from the response callback. `load` only fetches; `apply`
  // only writes. That split keeps the mount path free of a cascading render and
  // lets a mutation refresh the same data without duplicating the fetch.
  const load = useCallback(async () => {
    const [packages, counts] = await Promise.all([
      contentStudio.packages(60),
      contentStudio.summary(),
    ]);
    return { packages, summary: counts };
  }, []);

  const apply = useCallback((next: { packages: StudioPackageRow[]; summary: Summary }) => {
    setError(null);
    setRows(next.packages);
    setSummary(next.summary);
  }, []);

  useEffect(() => {
    let active = true;
    void load()
      .then((next) => {
        if (active) apply(next);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setRows([]);
        setError(e instanceof Error ? e.message : "The Content Studio could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [load, apply]);

  const create = useCallback(async () => {
    if (!topic.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await contentStudio.startPackage({ topic });
      setTopic("");
      setOpen(false);
      apply(await load());
    } catch (e) {
      setError(e instanceof Error ? e.message : "The content package could not be created.");
    } finally {
      setBusy(false);
    }
  }, [topic, load, apply]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Marketing"
        title="Content Studio"
        description="One idea becomes one content package: an article, a video, a thumbnail and a LinkedIn post that stay linked to each other. Nothing publishes without your approval."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load().then(apply).catch(() => undefined)}
            >
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setOpen((v) => !v)}>
              <Plus className="mr-2 size-4" />
              New package
            </Button>
          </>
        }
      />

      {open && (
        <div className="rounded-xl border border-border/70 bg-card/60 p-5">
          <p className="text-sm font-semibold text-foreground">Start a content package</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Give Atlas the topic. It will research Atlas's own knowledge, write the article,
            derive the video script from that article, generate the video and thumbnail, and
            draft the LinkedIn post. You review everything before anything is published.
          </p>
          <Textarea
            className="mt-3"
            rows={3}
            placeholder="e.g. Why insurance supplements get missed"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" disabled={busy || !topic.trim()} onClick={() => void create()}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Megaphone className="mr-2 size-4" />}
              Generate package
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={FileText} label="Drafts" value={summary["draft"] ?? 0} />
        <StatCard icon={Clock} label="Awaiting review" value={summary["awaiting_review"] ?? 0} />
        <StatCard icon={CheckCircle2} label="Published" value={summary["published"] ?? 0} />
        <StatCard
          icon={RefreshCw}
          label="Failed"
          value={summary["failed"] ?? 0}
          accent="text-destructive"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading content packages…</p>
      ) : rows.length === 0 ? (
        <EmptyPanel
          icon={Megaphone}
          title="No content packages yet"
          description="Start with a topic your customers actually ask about. Atlas keeps the article, video, thumbnail and LinkedIn post in one package."
          action={
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-2 size-4" />
              New package
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((row) => {
            const pkg = row.package;
            const id = String(pkg["_id"]);
            const thumbnail =
              (pkg["youtubeThumbnailUrl"] as string | null) ??
              (pkg["socialImage"] as string | null) ??
              (pkg["heroImage"] as string | null) ??
              null;
            const createdAt =
              typeof pkg["_creationTime"] === "number" ? (pkg["_creationTime"] as number) : null;
            return (
              <Link
                key={id}
                to={`/dashboard/content/${id}`}
                className="group flex gap-4 rounded-xl border border-border/70 bg-card/60 p-4 transition-colors hover:border-primary/40"
              >
                <div className="hidden h-20 w-32 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted sm:block">
                  {thumbnail ? (
                    <img src={thumbnail} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-widest text-muted-foreground">
                      No visual
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-foreground group-hover:underline">
                      {String(pkg["title"] ?? "Untitled")}
                    </p>
                    <Badge variant={pkg["status"] === "published" ? "default" : "secondary"}>
                      {String(pkg["approvalStatus"] ?? "pending")}
                    </Badge>
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {destinationStates(row).map((d) => (
                      <li key={`${d.label}`} className="flex items-center gap-1.5 text-xs">
                        <d.icon className={`size-3.5 ${toneClass(d.tone)}`} />
                        <span className="text-muted-foreground">{d.label}</span>
                        <span className={toneClass(d.tone)}>{d.state}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Created {createdAt ? formatDate(createdAt) : "—"}
                    {pkg["slug"] ? ` · /blog/${String(pkg["slug"])}` : ""}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-border/70 bg-card/40 p-5">
        <p className="text-sm font-semibold text-foreground">How a package flows</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {["Topic", "Article", "Video script", "Video", "Thumbnail", "Blog", "YouTube", "LinkedIn"].map(
            (step, i, all) => (
              <span key={step} className="flex items-center gap-2">
                <span className="rounded-full border border-border/70 bg-background px-2.5 py-1">
                  {step}
                </span>
                {i < all.length - 1 && <span aria-hidden>→</span>}
              </span>
            ),
          )}
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          The blog is the owned destination. YouTube is the video companion and LinkedIn drives
          traffic back to the article. A failure on one channel never invalidates the others.
        </p>
      </div>
    </div>
  );
}
