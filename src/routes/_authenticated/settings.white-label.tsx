import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import {
  getWhiteLabel,
  upsertWhiteLabel,
  verifyCustomDomain,
} from "@/lib/white-label/white-label.functions";
import { AppTopbar } from "@/components/app/app-topbar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Globe, ShieldCheck, CheckCircle2 } from "lucide-react";
import { useCurrentWorkspace, useWorkspaceRole } from "@/hooks/use-workspace";
import { ThemesSettings } from "./settings.themes";
import { Field } from "@/components/settings/white-label-fields";

export const Route = createFileRoute("/_authenticated/settings/white-label")({
  staticData: { breadcrumb: "Customization" },
  head: () => ({ meta: [{ title: "Customization — Settings" }] }),
  component: WhiteLabelSettings,
});

function WhiteLabelSettings() {
  const currentWorkspace = useCurrentWorkspace();
  const workspaceId = currentWorkspace.active?.id ?? null;
  const workspaceRole = useWorkspaceRole(workspaceId ?? undefined);

  if (currentWorkspace.isLoading || (workspaceId && workspaceRole.isPending)) {
    return (
      <>
        <AppTopbar
          title="Customization"
          subtitle="Themes, colors, brand identity, and workspace appearance."
        />
        <main className="container mx-auto max-w-7xl p-6 text-muted-foreground">Loading</main>
      </>
    );
  }

  if (!workspaceId) {
    return (
      <>
        <AppTopbar title="Customization" />
        <main className="container mx-auto max-w-7xl p-6 text-muted-foreground">
          Select a workspace before editing its branding.
        </main>
      </>
    );
  }

  if (workspaceRole.data !== "owner" && workspaceRole.data !== "admin") {
    return (
      <>
        <AppTopbar title="Customization" />
        <main className="mx-auto max-w-6xl w-full p-6 text-muted-foreground">
          Only workspace owners and admins can manage customization.
        </main>
      </>
    );
  }

  return (
    <>
      <AppTopbar
        title="Customization"
        subtitle="Manage workspace themes, colors, identity, and appearance."
      />
      <main className="mx-auto max-w-7xl w-full p-6 space-y-6">
        <ThemesSettings />
        <DomainSection workspaceId={workspaceId} />
      </main>
    </>
  );
}

/** Domain is deliberately not theme-scoped — a custom domain is a verified
 * DNS-level identity for the workspace, not a "look" a theme should swap. */
function DomainSection({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["white-label", workspaceId],
    queryFn: () => getWhiteLabel({ data: { workspaceId } }),
    enabled: Boolean(workspaceId),
  });
  const savedDomain = (data?.config as any)?.custom_domain ?? "";
  const [domain, setDomain] = useState(savedDomain);
  useEffect(() => setDomain(savedDomain), [savedDomain]);
  const verified = savedDomain === domain && (data?.config as any)?.custom_domain_verified;

  const save = useMutation({
    mutationFn: () => upsertWhiteLabel({ data: { workspaceId, custom_domain: domain || null } }),
    onSuccess: () => {
      toast.success("Domain saved");
      qc.invalidateQueries({ queryKey: ["white-label"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Save failed"),
  });

  const verify = useMutation({
    mutationFn: () => verifyCustomDomain({ data: { workspaceId } }),
    onSuccess: () => {
      toast.success("Domain verified");
      qc.invalidateQueries({ queryKey: ["white-label"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Verification failed"),
  });

  if (isLoading) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-4" />
          Custom domain
        </CardTitle>
        <CardDescription>
          Serve this workspace on your own domain. Stays the same no matter which theme is active.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Custom domain">
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="app.acme.com"
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending || domain === savedDomain}>
            {save.isPending ? "Saving" : "Save domain"}
          </Button>
        </div>
        {domain ? (
          <div className="rounded-control border border-border p-4 text-sm space-y-2 bg-muted/40">
            <p className="font-medium flex items-center gap-2">
              DNS setup{" "}
              {verified ? (
                <Badge className="gap-1">
                  <CheckCircle2 className="size-3" />
                  Verified
                </Badge>
              ) : (
                <Badge variant="secondary">Pending</Badge>
              )}
            </p>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              <li>
                Point <code className="font-mono">{domain}</code> to your app host and configure
                that hostname with your hosting provider.
              </li>
              <li>
                Add a TXT record for <code className="font-mono">_wacrm.{domain}</code> with value{" "}
                <code className="font-mono">wacrm-verify={workspaceId}</code>.
              </li>
            </ul>
            {savedDomain !== domain && (
              <p className="text-muted-foreground">Save changes before verifying this domain.</p>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => verify.mutate()}
              disabled={verify.isPending || savedDomain !== domain}
            >
              <ShieldCheck className="size-4 mr-2" />
              {verify.isPending ? "Verifying" : "Verify domain"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
