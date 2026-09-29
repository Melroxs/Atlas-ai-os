// ---------------------------------------------------------------------------
// Atlas Content Studio — package detail (/dashboard/content/:id)
//
// Tabs: Overview · Article · Video · Thumbnail · LinkedIn · Publishing · History
//
// Approval is a real state change (content_review_decide) and publishing is a
// durable job (content_engine_enqueue), never a browser-side side effect.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Linkedin,
  Loader2,
  RefreshCw,
  Send,
  Youtube,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, Panel, formatDate } from "@/components/atlas-ui";
import { contentStudio } from "@/lib/content-engine/studio-api";
import { BlogVideoCard } from "@/components/blog/BlogVideoCard";
import {
  DESTINATION_LABEL,
  type ContentAssetRecord,
  type ContentPackageView,
  type DestinationProvider,
} from "@/lib/content-engine/types";

const DESTINATION_ICON: Record<DestinationProvider, typeof FileText> = {
  blog: FileText,
  youtube: Youtube,
  linkedin: Linkedin,
};

/** Actionable wording for a failed publication — never a raw provider dump. */
function actionableError(pub: ContentPackageView["publications"][number]): string {
  const label = DESTINATION_LABEL[pub.provider];
  switch (pub.errorClass) {
    case "not_connected":
      return `${label} is not connected. Connect ${label} to publish this package.`;
    case "token_expired":
    case "authorization_revoked":
      return `${label} authorization expired. Reconnect ${label} to continue publishing.`;
    case "rate_limited":
      return `${label} rate-limited the request. Atlas will retry.`;
    case "invalid_content":
      return `${label} rejected the content. Review the package and try again.`;
    default:
      return `${label} publishing failed. Retry from the Publishing tab.`;
  }
}

function assetOf(
  view: ContentPackageView | null,
  contentType: string,
): ContentAssetRecord | null {
  if (!view) return null;
  return view.assets.find((a) => a.contentType === contentType) ?? null;
}

export default function ContentPackageDetail() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<ContentPackageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Fetch and state-write are separated so the mount effect subscribes to the
  // API and writes from the response callback instead of cascading a render.
  const load = useCallback(async () => {
    if (!id) return null;
    return contentStudio.package(id);
  }, [id]);

  const apply = useCallback((next: ContentPackageView | null) => {
    setError(next ? null : "This content package is not available to your organization.");
    setView(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    void load()
      .then((next) => {
        if (active) apply(next);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "The package could not be loaded.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, apply]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, message: string) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      try {
        await action();
        setNotice(message);
        apply(await load());
      } catch (e) {
        setError(e instanceof Error ? e.message : "That action could not be completed.");
      } finally {
        setBusy(null);
      }
    },
    [load, apply],
  );

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading content package…</p>;
  }

  if (!view) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow="Marketing" title="Content package" />
        <p className="text-sm text-destructive">
          {error ?? "This content package could not be found."}
        </p>
        <Button asChild variant="secondary" size="sm">
          <Link to="/dashboard/content">
            <ArrowLeft className="mr-2 size-4" />
            Back to Content Studio
          </Link>
        </Button>
      </div>
    );
  }

  const article = assetOf(view, "blog_article");
  const script = assetOf(view, "video_script");
  const video = assetOf(view, "youtube_video");
  const thumbnail = assetOf(view, "youtube_thumbnail");
  const linkedin = assetOf(view, "linkedin_post");
  const ogImage =
    typeof article?.metadata?.["ogImage"] === "string"
      ? (article.metadata["ogImage"] as string)
      : null;
  const thumbnailUrl =
    thumbnail?.externalUrl ?? view.youtubeThumbnailUrl ?? ogImage ?? null;

  const review = (decision: "in_review" | "approved" | "rejected") =>
    run(
      decision,
      () => contentStudio.review(view.packageId, decision),
      decision === "approved"
        ? "Package approved. Publishing is now unlocked."
        : decision === "rejected"
          ? "Package marked as rejected."
          : "Package moved back to review.",
    );

  const regenerate = (kind: "article" | "video" | "thumbnail" | "linkedin") =>
    run(
      `regen-${kind}`,
      () => contentStudio.regenerate(view.packageId, kind),
      `Queued regeneration of the ${kind}. Existing assets are updated in place, not duplicated.`,
    );

  const queue = (provider: DestinationProvider) =>
    run(
      `publish-${provider}`,
      () => contentStudio.queueDestination(view.packageId, provider),
      `Queued ${DESTINATION_LABEL[provider]} publishing. You can retry it without duplicating anything already published.`,
    );

  const publishBlogNow = () =>
    run(
      "publish-blog-now",
      () => contentStudio.publishBlog(view.packageId, view.slug),
      "Article published to the Atlas blog.",
    );

  const destinations: DestinationProvider[] = ["blog", "youtube", "linkedin"];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Content Studio"
        title={view.title}
        description={
          view.slug
            ? `Owned destination: /blog/${view.slug}`
            : "The article has not been published, so it has no public URL yet."
        }
        actions={
          <>
            <Button variant="secondary" size="sm" asChild>
              <Link to="/dashboard/content">
                <ArrowLeft className="mr-2 size-4" />
                All packages
              </Link>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load().then((next) => next && apply(next))}
            >
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
          </>
        }
      />

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <Panel title="Approval" description="Nothing is published to any channel before this is approved.">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={view.approvalStatus === "approved" ? "default" : "secondary"}>
            {view.approvalStatus}
          </Badge>
          <Badge variant="outline">{view.status}</Badge>
          <span className="flex-1" />
          <Button
            size="sm"
            disabled={busy !== null || view.approvalStatus === "approved"}
            onClick={() => void review("approved")}
          >
            {busy === "approved" ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}
            Approve package
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void review("in_review")}
          >
            Send back to review
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void review("rejected")}
          >
            Reject
          </Button>
        </div>
      </Panel>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="article">Article</TabsTrigger>
          <TabsTrigger value="video">Video</TabsTrigger>
          <TabsTrigger value="thumbnail">Thumbnail</TabsTrigger>
          <TabsTrigger value="linkedin">LinkedIn</TabsTrigger>
          <TabsTrigger value="publishing">Publishing</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {destinations.concat([]).map((provider) => {
              const pub = view.publications.find((p) => p.provider === provider) ?? null;
              const Icon = DESTINATION_ICON[provider];
              return (
                <div key={provider} className="rounded-xl border border-border/70 bg-card/60 p-4">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {DESTINATION_LABEL[provider]}
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    {pub ? pub.status : view.slug && provider === "blog" ? "ready" : "not queued"}
                  </p>
                </div>
              );
            })}
            <div className="rounded-xl border border-border/70 bg-card/60 p-4">
              <div className="flex items-center gap-2">
                <ImageIcon className="size-4 text-muted-foreground" />
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Thumbnail
                </span>
              </div>
              <p className="mt-2 text-sm font-semibold text-foreground">
                {thumbnail ? "generated" : "not generated"}
              </p>
            </div>
          </div>

          {view.youtubeUrl && (
            <BlogVideoCard
              thumbnailUrl={thumbnailUrl}
              youtubeUrl={view.youtubeUrl}
              title={view.title}
            />
          )}

          <Panel title="Assets" description="Every derivative of one idea, in one package.">
            <ul className="divide-y divide-border/60">
              {[
                { label: "Blog article", asset: article },
                { label: "Video script", asset: script },
                { label: "YouTube video", asset: video },
                { label: "YouTube thumbnail", asset: thumbnail },
                { label: "LinkedIn post", asset: linkedin },
              ].map(({ label, asset }) => (
                <li key={label} className="flex items-center justify-between py-2.5 text-sm">
                  <span className="text-foreground">{label}</span>
                  <span className="text-xs text-muted-foreground">
                    {asset ? asset.status : "not generated"}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </TabsContent>

        <TabsContent value="article" className="mt-4 space-y-4">
          <Panel
            title="Blog article"
            description="Written from Atlas knowledge. Facts without evidence are never invented."
            className="space-y-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void regenerate("article")}
              >
                {busy === "regen-article" ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 size-4" />
                )}
                Regenerate article
              </Button>
              {view.slug && (
                <Button size="sm" variant="ghost" asChild>
                  <a href={`/blog/${view.slug}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 size-4" />
                    View published article
                  </a>
                </Button>
              )}
            </div>
            {article?.body ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/30 p-4 text-sm leading-6 text-foreground/90">
                {article.body}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                The article has not been generated yet.
              </p>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="video" className="mt-4 space-y-4">
          <Panel title="Video script" description="Derived from the article, never from the topic alone.">
            <div className="mb-3 flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void regenerate("video")}
              >
                {busy === "regen-video" ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Youtube className="mr-2 size-4" />
                )}
                Regenerate video
              </Button>
            </div>
            {script?.body ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/30 p-4 text-sm leading-6 text-foreground/90">
                {script.body}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">No video script yet.</p>
            )}
          </Panel>
          <Panel title="Rendered video" description="Recorded on the package so a retry resumes the same render.">
            {video ? (
              <div className="space-y-2 text-sm">
                <p className="text-foreground">
                  Status: <span className="text-muted-foreground">{video.status}</span>
                </p>
                {video.externalUrl && (
                  <a
                    href={video.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-primary hover:underline"
                  >
                    <ExternalLink className="size-4" />
                    Open rendered video
                  </a>
                )}
                {video.provider && (
                  <p className="text-xs text-muted-foreground">Provider: {video.provider}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No video has been rendered. Video generation requires a configured provider.
              </p>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="thumbnail" className="mt-4 space-y-4">
          <Panel
            title="Shared thumbnail"
            description="One thumbnail per package: it is the video poster, the blog hero and the Open Graph image."
          >
            <div className="mb-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void regenerate("thumbnail")}
              >
                {busy === "regen-thumbnail" ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <ImageIcon className="mr-2 size-4" />
                )}
                Regenerate thumbnail
              </Button>
            </div>
            {thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt=""
                className="w-full max-w-xl rounded-lg border border-border/60"
              />
            ) : (
              <p className="text-sm text-muted-foreground">No thumbnail has been generated yet.</p>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="linkedin" className="mt-4 space-y-4">
          <Panel title="LinkedIn post" description="Rewritten for LinkedIn and pointing at the owned article.">
            <div className="mb-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void regenerate("linkedin")}
              >
                {busy === "regen-linkedin" ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Linkedin className="mr-2 size-4" />
                )}
                Regenerate LinkedIn post
              </Button>
            </div>
            {linkedin?.body ? (
              <pre className="whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/30 p-4 text-sm leading-6 text-foreground/90">
                {linkedin.body}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">No LinkedIn post has been written yet.</p>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="publishing" className="mt-4 space-y-4">
          <Panel
            title="Destinations"
            description="Each destination has its own state, its own retry and its own error. One failure never invalidates another."
          >
            <ul className="divide-y divide-border/60">
              {destinations.map((provider) => {
                const pub = view.publications.find((p) => p.provider === provider) ?? null;
                const Icon = DESTINATION_ICON[provider];
                return (
                  <li key={provider} className="flex flex-wrap items-center gap-3 py-3">
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">
                      {DESTINATION_LABEL[provider]}
                    </span>
                    <Badge variant={pub?.status === "published" ? "default" : "secondary"}>
                      {pub?.status ?? "not queued"}
                    </Badge>
                    {pub?.externalUrl && (
                      <a
                        href={pub.externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <ExternalLink className="size-3.5" />
                        Open
                      </a>
                    )}
                    {pub?.status === "failed" && (
                      <span className="flex w-full items-center gap-1.5 text-xs text-destructive">
                        <AlertTriangle className="size-3.5" />
                        {actionableError(pub)}
                      </span>
                    )}
                    <span className="flex-1" />
                    {provider === "blog" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null || !view.slug || view.status === "published"}
                        onClick={() => void publishBlogNow()}
                      >
                        {busy === "publish-blog-now" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <Send className="mr-2 size-4" />
                        )}
                        {view.status === "published" ? "Published" : "Publish article"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => void queue(provider)}
                      >
                        {busy === `publish-${provider}` ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <Send className="mr-2 size-4" />
                        )}
                        {pub?.status === "published" ? "Re-queue (idempotent)" : "Queue publish"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Panel>
        </TabsContent>

        <TabsContent value="history" className="mt-4 space-y-4">
          <Panel title="Publication history" description="What actually left Atlas, and when.">
            {view.publications.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has been queued yet.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {view.publications.map((pub) => (
                  <li key={pub._id} className="py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {DESTINATION_LABEL[pub.provider]}
                      </span>
                      <Badge variant="outline">{pub.status}</Badge>
                      <span className="text-xs text-muted-foreground">
                        attempts: {pub.attemptCount}
                        {pub.publishedAt ? ` · published ${formatDate(pub.publishedAt)}` : ""}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {pub.idempotencyKey}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
