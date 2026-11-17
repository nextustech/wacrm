import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Building2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createMyOrganization, ensureMyOrganization } from "@/lib/tenant/provision.functions";
import { writeActiveOrgId } from "@/lib/tenant/active-tenant";

/**
 * Where a signed-in user lands with no organization.
 *
 * This only happens after they delete the last one they had: a first-time user
 * is still provisioned automatically. It lives outside `_authenticated`,
 * because that layout requires an organization to exist.
 */
export const Route = createFileRoute("/onboarding/organization")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Create an organization" }, { name: "robots", content: "noindex" }],
  }),
  beforeLoad: async ({ location }) => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/auth", search: { next: location.href } });

    // Don't strand someone here who does have an organization (e.g. they were
    // invited to one, or came back to a stale tab).
    const existing = await ensureMyOrganization().catch(() => null);
    if (existing?.organizationId) {
      writeActiveOrgId(existing.organizationId);
      throw redirect({ to: "/dashboard" });
    }
  },
  component: CreateOrganizationPage,
});

function CreateOrganizationPage() {
  const navigate = useNavigate();
  const createOrg = useServerFn(createMyOrganization);
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: async () => createOrg({ data: { name: name.trim() } }),
    onSuccess: ({ organizationId }) => {
      writeActiveOrgId(organizationId);
      navigate({ to: "/dashboard", replace: true });
    },
    onError: (error: Error) => toast.error(error.message || "Could not create the organization"),
  });

  return (
    <div className="grid min-h-dvh place-items-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 grid h-11 w-11 place-items-center rounded-control bg-primary/10 text-primary">
            <Building2 className="h-5 w-5" />
          </div>
          <CardTitle>Create an organization</CardTitle>
          <CardDescription>
            Your account isn't part of an organization yet. Create one to get a workspace and start
            using the app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!create.isPending && name.trim()) create.mutate();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="org-name">Organization name</Label>
              <Input
                id="org-name"
                autoFocus
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Inc."
              />
            </div>
            <Button type="submit" className="w-full" disabled={create.isPending || !name.trim()}>
              {create.isPending ? "Creating" : "Create organization"}
            </Button>
          </form>
          <button
            type="button"
            className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void supabase.auth.signOut().then(() => navigate({ to: "/auth" }))}
          >
            Sign out
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
