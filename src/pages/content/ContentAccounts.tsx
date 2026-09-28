// ---------------------------------------------------------------------------
// Atlas Content Studio — connected accounts (/dashboard/content/accounts)
//
// YouTube and LinkedIn are connected through the EXISTING OAuth flow
// (supabase/functions/integrations-oauth) and stored in the EXISTING credential
// store (public.connections). No second credential system, and the browser only
// ever receives an authorization URL: the client secret, the code verifier and
// the tokens all stay server-side.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Linkedin, Loader2, PlugZap, RefreshCw, Youtube } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/atlas-ui";
import { contentStudio } from "@/lib/content-engine/studio-api";
import { getSupabaseClient, resolvedSupabaseUrl } from "@/lib/supabase";
import { rpcCall } from "@/lib/actions/rpc";

type ConnectionRow = {
  id: string;
  provider: string;
  status: string;
  accountName: string | null;
  scopes: string[];
  lastError: string | null;
};

const PROVIDERS = [
  {
    id: "youtube",
    label: "YouTube",
    icon: Youtube,
    blurb:
      "Uploads the rendered video to your channel, sets the thumbnail, and records the canonical video URL on the content package.",
    clientIdEnv: "YOUTUBE_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_CLIENT_SECRET",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    icon: Linkedin,
    blurb:
      "Publishes the LinkedIn version of the package, linking back to the Atlas article as the owned destination.",
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
  },
] as const;

export default function ContentAccounts() {
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  // Fetch and state-write are separated so the mount effect subscribes to the
  // API and writes from the response callback rather than cascading a render.
  const load = useCallback(async () => {
    const rows = await contentStudio.connections();
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      status: r.status,
      accountName: r.accountName,
      scopes: r.scopes,
      lastError: r.lastError,
    }));
  }, []);

  const apply = useCallback((rows: ConnectionRow[]) => {
    setError(null);
    setConnections(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    void load()
      .then((rows) => {
        if (active) apply(rows);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Connected accounts could not be loaded.");
        setLoading(false);
      });
    return () => {
      active = false;
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [load, apply]);

  const connect = useCallback(
    async (provider: string) => {
      setBusy(provider);
      setError(null);
      setNotice(null);
      try {
        const supabase = getSupabaseClient();
        const session = await supabase?.auth.getSession();
        const token = session?.data.session?.access_token;
        if (!token) throw new Error("Sign in again before connecting an account.");
        if (!resolvedSupabaseUrl) throw new Error("The Supabase project URL is not configured.");

        const response = await fetch(`${resolvedSupabaseUrl}/functions/v1/integrations-oauth`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            provider,
            returnTo: `${window.location.origin}/dashboard/content/accounts`,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          authorizationUrl?: string;
          error?: string;
        };
        if (!response.ok || !payload.authorizationUrl) {
          throw new Error(
            payload.error ??
              `${provider} could not be started. Its OAuth client may not be configured yet.`,
          );
        }

        window.open(payload.authorizationUrl, "_blank", "noopener,noreferrer,width=560,height=760");
        setNotice(
          `Authorize Atlas in the ${provider} window that opened. This page refreshes as soon as the connection is registered.`,
        );

        // The callback is registered server-side; poll until the row appears.
        let attempts = 0;
        if (pollTimer.current) window.clearInterval(pollTimer.current);
        pollTimer.current = window.setInterval(() => {
          attempts += 1;
          void load()
            .then(apply)
            .catch(() => undefined);
          if (attempts > 40) {
            if (pollTimer.current) window.clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        }, 3000);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The connection could not be started.");
      } finally {
        setBusy(null);
      }
    },
    [load, apply],
  );

  const disconnect = useCallback(
    async (connectionId: string) => {
      setBusy(connectionId);
      setError(null);
      setNotice(null);
      try {
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Atlas is not connected to Supabase in this environment.");
        // Revokes the connection server-side; the sealed tokens are dropped with it.
        await rpcCall(supabase, "connections_disconnect", { p_connection_id: connectionId });
        setNotice("Account disconnected. Reconnect it any time to resume publishing.");
        apply(await load());
      } catch (e) {
        setError(e instanceof Error ? e.message : "The account could not be disconnected.");
      } finally {
        setBusy(null);
      }
    },
    [load, apply],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Marketing"
        title="Content Accounts"
        description="Agent accounts publish to your channels using OAuth. Atlas never asks for a YouTube or LinkedIn password, and the tokens never reach the browser."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load().then(apply).catch(() => undefined)}
          >
            <RefreshCw className="mr-2 size-4" />
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3 text-sm text-foreground">
          {notice}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {PROVIDERS.map((provider) => {
          const connection = connections.find((c) => c.provider === provider.id) ?? null;
          const connected = connection
            ? ["connected", "healthy", "degraded", "syncing"].includes(connection.status)
            : false;
          return (
            <Panel key={provider.id} title={provider.label} description={provider.blurb}>
              <div className="flex flex-wrap items-center gap-3">
                <provider.icon className="size-5 text-muted-foreground" />
                <Badge variant={connected ? "default" : "secondary"}>
                  {connection?.status ?? "not connected"}
                </Badge>
                {connection?.accountName && (
                  <span className="text-xs text-muted-foreground">{connection.accountName}</span>
                )}
                <span className="flex-1" />
                {connected ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void disconnect(connection!.id)}
                  >
                    {busy === connection!.id ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : null}
                    Disconnect
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy !== null} onClick={() => void connect(provider.id)}>
                    {busy === provider.id ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <PlugZap className="mr-2 size-4" />
                    )}
                    Connect {provider.label}
                  </Button>
                )}
              </div>

              {connection?.lastError && (
                <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {connection.lastError}
                </p>
              )}

              <div className="mt-4 rounded-lg border border-border/60 bg-muted/20 p-3">
                <p className="text-xs font-medium text-foreground">Required server configuration</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Add <code className="font-mono">{provider.clientIdEnv}</code> and{" "}
                  <code className="font-mono">{provider.clientSecretEnv}</code> to the project's
                  environment, and register the callback URL{" "}
                  <code className="break-all font-mono">
                    {resolvedSupabaseUrl}/functions/v1/integrations-oauth/callback
                  </code>{" "}
                  in the provider's developer console. Until then, connecting fails with an
                  explicit “not configured” message rather than a simulated success.
                </p>
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel
        title="What Atlas stores"
        description="Connections use the same credential store as every other Atlas integration."
      >
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading connections…</p>
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No publishing accounts are connected yet. The blog does not need one — it publishes
            inside Atlas.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {connections.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2.5 text-sm">
                <span className="text-foreground">{c.provider}</span>
                <span className="text-xs text-muted-foreground">
                  {c.scopes.length} scope{c.scopes.length === 1 ? "" : "s"} · {c.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
