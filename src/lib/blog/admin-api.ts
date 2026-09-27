// ---------------------------------------------------------------------------
// Atlas Blog — admin RPC bindings
//
// These mirror the server-side functions installed by migration
// 20260920_atlas_blog_publishing.sql. They are declared here rather than inside
// src/lib/api.ts because that module already carries the whole platform
// surface; the runtime contract is identical (useQuery / useMutation consume
// { name, kind, transform? }).
//
// Authorization is NOT expressed here. `anon` has no EXECUTE grant on any of
// these functions, and each one re-checks the caller's platform role inside the
// database (is_super_admin / is_atlas_admin). A non-admin therefore gets a
// 42501 refusal from Postgres, not a client-side suggestion.
// ---------------------------------------------------------------------------

import type { ApiFn } from "@/lib/api";

export interface AdminContentItem {
  _id: string;
  contentType: string;
  status: string;
  approvalStatus: string;
  slug: string | null;
  title: string;
  summary: string | null;
  seo: Record<string, unknown> | null;
  jurisdiction: string | null;
  industry: string | null;
  category: string | null;
  tags: string[];
  author: string | null;
  heroImage: string | null;
  socialImage: string | null;
  readingTime: number | null;
  ctaId: string | null;
  aiGenerated: boolean;
  imagePrompt: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  knowledgeIds: unknown[];
  sourceIds: unknown[];
  parentContentId: string | null;
  failureReason: string | null;
  publishedAt: number | null;
  approvedAt: number | null;
  updatedAt: number | null;
  hasBody: boolean;
}

/** Result of an admin edit. */
export interface AdminUpdateResult {
  ok: boolean;
  error?: string;
  detail?: string;
  updatedAt?: number;
}

/** Result of an unpublish. */
export interface UnpublishResult {
  ok: boolean;
  status?: string;
  previousSlug?: string | null;
  error?: string;
  detail?: string;
}

export interface ReviewDecisionResult {
  ok: boolean;
  status?: string;
  approvalStatus?: string;
  error?: string;
}

export interface PublishResult {
  ok: boolean;
  status?: string;
  slug?: string;
  canonicalUrl?: string | null;
  publishedAt?: number;
  error?: string;
  detail?: string;
}

export const blogAdminApi: {
  contentAdminList: ApiFn<AdminContentItem[]>;
  contentReviewDecide: ApiFn<ReviewDecisionResult>;
  contentPublishBlog: ApiFn<PublishResult>;
  contentAdminUpdate: ApiFn<AdminUpdateResult>;
  contentUnpublish: ApiFn<UnpublishResult>;
} = {
  /** Pipeline listing, any status. Admin-guarded inside the function. */
  contentAdminList: { name: "content_admin_list", kind: "query" },
  /** REVIEW -> APPROVED / REJECTED / NEEDS_CHANGES. Admin-guarded. */
  contentReviewDecide: { name: "content_review_decide", kind: "mutation" },
  /** The single publish path: validates, slugs, and records publication. */
  contentPublishBlog: { name: "content_publish_blog", kind: "mutation" },
  /**
   * Edit publication metadata. Refuses to run on a published row, and can
   * never set `status` — the browser has no way to bypass the approval gate.
   */
  contentAdminUpdate: { name: "content_admin_update", kind: "mutation" },
  /** The only supported way to take a live article down. Archives, never deletes. */
  contentUnpublish: { name: "content_unpublish", kind: "mutation" },
};
