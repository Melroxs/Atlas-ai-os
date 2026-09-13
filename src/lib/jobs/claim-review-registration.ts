// ---------------------------------------------------------------------------
// Atlas Claim Review — Job Handler Registration
//
// Registers all claim review job handlers with the Handler Registry.
// This is called at worker startup to wire the orchestrator into
// the existing Jobs infrastructure.
// ---------------------------------------------------------------------------

import { registerJobHandler } from "./handler-registry";
import {
  handleClaimReviewJob,
  handleSupplementPrepJob,
  handleDailyScanJob,
  CLAIM_REVIEW_JOB_TYPES,
} from "./claim-review-handler";

/**
 * Register all claim review job handlers.
 * Call this once at worker startup.
 */
export function registerClaimReviewHandlers(): void {
  registerJobHandler(CLAIM_REVIEW_JOB_TYPES.FULL_REVIEW, handleClaimReviewJob);
  registerJobHandler(CLAIM_REVIEW_JOB_TYPES.SUPPLEMENT_PREP, handleSupplementPrepJob);
  registerJobHandler(CLAIM_REVIEW_JOB_TYPES.DAILY_SCAN, handleDailyScanJob);
}
