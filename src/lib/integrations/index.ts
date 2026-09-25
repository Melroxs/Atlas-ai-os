// ---------------------------------------------------------------------------
// Atlas Integration Platform — public surface
//
// Import from "@/lib/integrations" everywhere. The provider LIST is not defined
// here: it lives in "@/lib/atlas-data/connectors-registry" (one registry, no
// duplicates) and the executable-capability surface stays in
// "@/lib/atlas-data/tools-registry".
// ---------------------------------------------------------------------------

export * from "./types";
export * from "./errors";
export * from "./mapping";
export * from "./sync";
export * from "./tools";
export {
  AdapterRegistrationError,
  assertAdapterCapabilities,
  clearAdapters,
  deriveLifecycle,
  describeProvider,
  getAdapter,
  hasAdapter,
  implementedCapabilities,
  listRegistrationFailures,
  listResolvedProviders,
  recordRegistrationFailure,
  registerAdapter,
  requireCapability,
} from "./adapters";
export {
  MAX_WEBHOOK_BYTES,
  base64UrlDecode,
  base64UrlEncode,
  createPkcePair,
  guardWebhookPayload,
  openCredential,
  parseSignatureHeader,
  randomToken,
  sealCredential,
  sha256Hex,
  signHmacSha256Hex,
  stateHash,
  timingSafeEqualHex,
  verifyWebhookSignature,
  webhookDedupeKey,
} from "./primitives";
export {
  TOKEN_REFRESH_SKEW_MS,
  beginAuthorization,
  integrationRedirectUri,
  missingScopes,
  parseCallback,
  parseTokenResponse,
  tokenNeedsRefresh,
  validateCallback,
} from "./oauth";
export { handleInboundWebhook } from "./webhook";
export type {
  InboundWebhookInput,
  WebhookOutcome,
  WebhookPorts,
  WebhookProviderPolicy,
  WebhookResult,
} from "./webhook";
