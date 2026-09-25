// ---------------------------------------------------------------------------
// Atlas integrations-oauth — reusable OAuth 2.0 flow (§7)
//
//   start    POST { action: "start", provider, returnTo? }
//            → authenticated, organization-bound, returns ONLY the
//              authorization URL (state + PKCE verifier stay server-side)
//
//   callback GET/POST /callback?code=…&state=…
//            → validates + consumes the single-use state, exchanges the code,
//              seals the tokens and registers the connection
//
// The browser never sees a client_secret, a code_verifier, an access token or a
// refresh token. It receives a redirect URL and, after the callback, a
// redirect back into Atlas.
//
// Honesty contract: a provider whose OAuth client credentials are not configured
// fails CLOSED with a message that says exactly what is missing. Nothing here
// simulates a successful connection.
// ---------------------------------------------------------------------------

import {
  atlasEdgeCorsHeaders,
  atlasEdgeError,
  atlasEdgeJson,
  atlasEdgePreflight,
  requireAtlasCaller,
} from "../_shared/edge-auth.ts";
import {
  base64UrlEncode,
  openCredential,
  randomToken,
  sealCredential,
} from "../_shared/integration/primitives.ts";
import { credentialKey, log, rpc } from "../_shared/integration/service.ts";

interface OAuthProviderDefinition {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  usePkce: boolean;
  /** Extra authorize parameters. */
  authorizeParams?: Record<string, string>;
  category: string;
}

/**
 * Provider OAuth definitions. Only providers with a PUBLICLY documented OAuth
 * endpoint appear here. A provider gated behind a partner agreement has no entry
 * until its API contract is actually available — it is never guessed.
 */
const PROVIDERS: Record<string, OAuthProviderDefinition> = {
  google_gmail: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    usePkce: true,
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    category: "email",
  },
  google_drive: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    usePkce: true,
    authorizeParams: { access_type: "offline", prompt: "consent" },
    category: "document_storage",
  },
  microsoft_365: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["Files.Read.All", "offline_access"],
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
    usePkce: true,
    category: "document_storage",
  },
  slack: {
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: ["channels:history", "channels:read", "files:read", "users:read"],
    clientIdEnv: "SLACK_CLIENT_ID",
    clientSecretEnv: "SLACK_CLIENT_SECRET",
    usePkce: false,
    category: "communication",
  },
  hubspot: {
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    scopes: ["crm.objects.contacts.read", "crm.objects.companies.read", "crm.objects.deals.read"],
    clientIdEnv: "HUBSPOT_CLIENT_ID",
    clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
    usePkce: false,
    category: "crm",
  },
};

const STATE_TTL_MS = 10 * 60 * 1000;

function redirectUri(request: Request): string {
  return `${new URL(request.url).origin}/functions/v1/integrations-oauth/callback`;
}

Deno.serve(async (req) => {
  const preflight = atlasEdgePreflight(req);
  if (preflight) return preflight;

  const url = new URL(req.url);
  const isCallback = url.pathname.endsWith("/callback");

  if (!isCallback) {
    // ---- start: requires an authenticated caller --------------------------
    try {
      const caller = await requireAtlasCaller(req);
      if (!caller.tenantId) {
        return atlasEdgeError("You need an active Atlas organization to connect an integration.", 403, atlasEdgeCorsHeaders(req));
      }
      if (!["owner", "admin", "manager"].includes(caller.role ?? "")) {
        return atlasEdgeError("Only organization managers can connect integrations.", 403, atlasEdgeCorsHeaders(req));
      }

      const body = (await req.json().catch(() => ({}))) as { provider?: string; returnTo?: string };
      const provider = (body.provider ?? "").toLowerCase();
      const definition = PROVIDERS[provider];
      if (!definition) {
        return atlasEdgeError(
          `"${provider || "(none)"}" is not available for connection yet.`,
          404,
          atlasEdgeCorsHeaders(req),
        );
      }
      const clientId = Deno.env.get(definition.clientIdEnv) ?? "";
      const clientSecret = Deno.env.get(definition.clientSecretEnv) ?? "";
      if (!clientId || !clientSecret) {
        return atlasEdgeError(
          `${provider} is not configured on this Atlas deployment. Add ${definition.clientIdEnv} and ${definition.clientSecretEnv} in project settings first.`,
          409,
          atlasEdgeCorsHeaders(req),
        );
      }

      const state = randomToken(32);
      const verifier = definition.usePkce ? randomToken(32) : null;
      const challenge = verifier
        ? base64UrlEncode(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
          )
        : undefined;

      const authorize = new URL(definition.authorizeUrl);
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", redirectUri(req));
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("state", state);
      if (definition.scopes.length > 0) authorize.searchParams.set("scope", definition.scopes.join(" "));
      if (challenge) {
        authorize.searchParams.set("code_challenge", challenge);
        authorize.searchParams.set("code_challenge_method", "S256");
      }
      for (const [key, value] of Object.entries(definition.authorizeParams ?? {})) {
        authorize.searchParams.set(key, value);
      }

      await rpc("integration_oauth_state_create", {
        p_state_hash: await sha256Hex(state),
        p_organization_id: caller.tenantId,
        p_user_id: caller.userId,
        p_provider: provider,
        p_redirect_uri: redirectUri(req),
        p_return_to: typeof body.returnTo === "string" ? body.returnTo : null,
        p_code_verifier: verifier,
        p_scopes: definition.scopes,
        p_ttl_ms: STATE_TTL_MS,
      });

      log("oauth.state_created", { provider, organizationId: caller.tenantId });
      return atlasEdgeJson({ authorizationUrl: authorize.toString(), provider }, 200, atlasEdgeCorsHeaders(req));
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      const message = error instanceof Error ? error.message : "OAuth could not be started.";
      log("oauth.start_failed", { status, detail: message.slice(0, 200) });
      return atlasEdgeError(message, status, atlasEdgeCorsHeaders(req));
    }
  }

  // ---- callback: the provider redirects the browser here ------------------
  try {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    if (providerError || !state || !code) {
      return atlasEdgeError(
        providerError ? `Authorization failed: ${providerError}` : "Invalid authorization callback.",
        400,
        atlasEdgeCorsHeaders(req),
      );
    }

    // Single-use, time-limited, provider-bound, organization-bound state.
    const consumed = await rpc<{
      ok: boolean;
      reason?: string;
      organization_id?: string;
      user_id?: string;
      provider?: string;
      redirect_uri?: string;
      code_verifier?: string | null;
    }>("integration_oauth_state_consume", {
      p_state_hash: await sha256Hex(state),
      p_provider: null,
    });

    if (!consumed.ok) {
      const reason = consumed.reason ?? "invalid_state";
      log("oauth.state_rejected", { reason });
      return atlasEdgeError("This authorization request is no longer valid. Start again.", 400, atlasEdgeCorsHeaders(req));
    }

    const provider = consumed.provider ?? "";
    const definition = PROVIDERS[provider];
    if (!definition) {
      return atlasEdgeError(`Provider "${provider}" is not available.`, 404, atlasEdgeCorsHeaders(req));
    }
    const clientId = Deno.env.get(definition.clientIdEnv) ?? "";
    const clientSecret = Deno.env.get(definition.clientSecretEnv) ?? "";
    // Renamed locally: `credentialKey` is the imported function; shadowing it
    // here would raise `TypeError: credentialKey is not a function` on every
    // callback and fail every OAuth completion with a 500.
    const keyMaterial = credentialKey();
    if (!clientId || !clientSecret || !keyMaterial) {
      return atlasEdgeError(
        `${provider} is missing server configuration; the authorization cannot be completed.`,
        409,
        atlasEdgeCorsHeaders(req),
      );
    }

    // ---- code exchange (server-side only) --------------------------------
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: consumed.redirect_uri ?? redirectUri(req),
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (consumed.code_verifier) tokenBody.set("code_verifier", consumed.code_verifier);

    const tokenResponse = await fetch(definition.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenJson = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken = typeof tokenJson.access_token === "string" ? tokenJson.access_token : "";
    if (!tokenResponse.ok || !accessToken) {
      log("oauth.exchange_failed", { provider, status: tokenResponse.status });
      return atlasEdgeError(
        `${provider} did not return an access token. The authorization was not completed.`,
        502,
        atlasEdgeCorsHeaders(req),
      );
    }

    const keyVersion = 1;
    const accessSealed = await sealCredential(accessToken, keyMaterial, keyVersion);
    const refreshToken =
      typeof tokenJson.refresh_token === "string" && tokenJson.refresh_token ? tokenJson.refresh_token : null;
    const refreshSealed = refreshToken ? await sealCredential(refreshToken, keyMaterial, keyVersion) : null;
    const expiresIn = typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : null;
    const grantedScopes =
      typeof tokenJson.scope === "string"
        ? tokenJson.scope.split(/[\s,]+/).filter(Boolean)
        : definition.scopes;

    const registered = await rpc<{ connection_id: string }>("connections_register", {
      p_organization_id: consumed.organization_id,
      p_provider: provider,
      p_category: definition.category,
      p_connection_type: "oauth2",
      p_account_email: null,
      p_scopes: grantedScopes,
      p_capabilities: ["read", "polling"],
      p_access_token_enc: accessSealed.sealed,
      p_refresh_token_enc: refreshSealed?.sealed ?? null,
      p_token_expires_at: expiresIn === null ? null : Date.now() + expiresIn * 1000,
      p_token_key_version: keyVersion,
    });

    // Round-trip proof the sealed value is openable with the configured key.
    await openCredential(accessSealed.sealed, keyMaterial);

    log("oauth.connected", { provider, organizationId: consumed.organization_id });
    return atlasEdgeJson({ connected: true, provider, connectionId: registered.connection_id }, 200, atlasEdgeCorsHeaders(req));
  } catch (error) {
    log("oauth.callback_failed", {
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return atlasEdgeError("Authorization could not be completed.", 500, atlasEdgeCorsHeaders(req));
  }
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
