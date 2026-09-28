// ---------------------------------------------------------------------------
// Atlas Content Studio — settings (/dashboard/content/settings)
//
// Brand voice, audience, CTA and content automation. The DEFAULT is approval
// required: autonomous publishing has to be switched on deliberately and the
// database refuses to store auto-publish while approval is still required.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, Panel, formatDate } from "@/components/atlas-ui";
import { contentStudio } from "@/lib/content-engine/studio-api";
import {
  AUTOMATION_FREQUENCIES,
  type ContentAutomationSettings,
} from "@/lib/content-engine/types";

function frequencyId(seconds: number | null): string {
  const match = AUTOMATION_FREQUENCIES.find((f) => f.seconds === seconds);
  return match ? match.id : "manual";
}

export default function ContentSettings() {
  const [settings, setSettings] = useState<ContentAutomationSettings | null>(null);
  const [frequency, setFrequency] = useState("manual");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Fetch and state-write are separated so the mount effect subscribes to the
  // API and writes from the response callback rather than cascading a render.
  const load = useCallback(async () => contentStudio.automation(), []);

  const apply = useCallback((next: ContentAutomationSettings) => {
    setSettings(next);
    setFrequency(frequencyId(next.intervalSeconds));
  }, []);

  useEffect(() => {
    let active = true;
    void load()
      .then((next) => {
        if (active) apply(next);
      })
      .catch((e: unknown) => {
        if (active) {
          setError(e instanceof Error ? e.message : "Content settings could not be loaded.");
        }
      });
    return () => {
      active = false;
    };
  }, [load, apply]);

  const patch = (changes: Partial<ContentAutomationSettings>) =>
    setSettings((current) => (current ? { ...current, ...changes } : current));

  const save = useCallback(async () => {
    if (!settings) return;
    const seconds =
      AUTOMATION_FREQUENCIES.find((f) => f.id === frequency)?.seconds ?? null;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await contentStudio.saveAutomation({
        enabled: settings.enabled,
        intervalSeconds: seconds,
        requireApproval: settings.requireApproval,
        autoPublish: settings.autoPublish,
        brandVoice: settings.brandVoice,
        audience: settings.audience,
        primaryCta: settings.primaryCta,
        defaultTone: settings.defaultTone,
      });
      setNotice("Content settings saved.");
      apply(await load());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Content settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }, [settings, frequency, load, apply]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Marketing"
        title="Content Settings"
        description="How Atlas writes for you, and how much of the workflow it is allowed to run on its own."
        actions={
          <Button size="sm" onClick={() => void save()} disabled={saving || !settings}>
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            Save settings
          </Button>
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

      {!settings ? (
        <p className="text-sm text-muted-foreground">Loading content settings…</p>
      ) : (
        <>
          <Panel title="Brand voice" description="Used by every generator in this workspace.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="audience">Audience</Label>
                <Input
                  id="audience"
                  placeholder="US restoration and roofing business owners"
                  value={settings.audience ?? ""}
                  onChange={(e) => patch({ audience: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tone">Default tone</Label>
                <Input
                  id="tone"
                  placeholder="Professional, specific, evidence-oriented"
                  value={settings.defaultTone ?? ""}
                  onChange={(e) => patch({ defaultTone: e.target.value })}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="voice">Brand voice</Label>
                <Textarea
                  id="voice"
                  rows={3}
                  placeholder="How Atlas should sound when it writes as your company."
                  value={settings.brandVoice ?? ""}
                  onChange={(e) => patch({ brandVoice: e.target.value })}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="cta">Primary call to action</Label>
                <Input
                  id="cta"
                  placeholder="See how Atlas recovers missed revenue"
                  value={settings.primaryCta ?? ""}
                  onChange={(e) => patch({ primaryCta: e.target.value })}
                />
              </div>
            </div>
          </Panel>

          <Panel
            title="Content automation"
            description="Automated generation always lands in review first unless you explicitly turn approval off."
          >
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Generate content automatically</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    When enabled, Atlas selects an uncovered topic from your knowledge and prepares a
                    full package.
                  </p>
                </div>
                <Switch
                  checked={settings.enabled}
                  onCheckedChange={(checked) => patch({ enabled: checked })}
                />
              </div>

              <div className="space-y-2">
                <Label>Frequency</Label>
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger className="w-full sm:w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTOMATION_FREQUENCIES.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Truthfulness, not decoration. Every option above is honoured
                    by content_automation_list_due, and the tick itself is a
                    durable Atlas job — but Atlas has no in-database scheduler,
                    so something must invoke the content worker. Saying so is
                    the difference between a schedule that works and one the
                    user believes in. */}
                <p className="text-xs leading-5 text-muted-foreground">
                  The schedule is stored and enforced by Atlas, but it only fires while the Atlas
                  content worker is deployed and being invoked on a schedule. If no worker runs,
                  nothing is generated on its own — create packages from the Content Studio until
                  the worker is running.
                </p>
              </div>

              <div className="flex items-start justify-between gap-4 border-t border-border/60 pt-5">
                <div>
                  <p className="text-sm font-medium text-foreground">Require approval before publishing</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Recommended. Atlas prepares everything and waits for a human decision.
                  </p>
                </div>
                <Switch
                  checked={settings.requireApproval}
                  onCheckedChange={(checked) =>
                    // Turning approval off is what unlocks auto-publish; the
                    // database rejects auto-publish while approval is required.
                    patch({
                      requireApproval: checked,
                      ...(checked ? { autoPublish: false } : {}),
                    })
                  }
                />
              </div>

              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Auto-publish approved packages</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Off by default. Requires approval to be disabled first, and publishing still
                    requires a connected account for each channel.
                  </p>
                </div>
                <Switch
                  checked={settings.autoPublish}
                  disabled={settings.requireApproval}
                  onCheckedChange={(checked) => patch({ autoPublish: checked })}
                />
              </div>

              {settings.requireApproval && (
                <p className="text-xs text-muted-foreground">
                  Approval is required, so nothing will be published to any channel without you.
                </p>
              )}
            </div>
          </Panel>

          <Panel
            title="Covered topics"
            description="Atlas skips what has already been covered instead of recycling the same article."
          >
            {settings.coveredTopics.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No topics have been generated yet.
                {settings.lastGeneratedAt
                  ? ` Last run ${formatDate(settings.lastGeneratedAt)}.`
                  : ""}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {settings.coveredTopics.map((topic) => (
                  <li key={topic}>
                    <Badge variant="outline">{topic}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
