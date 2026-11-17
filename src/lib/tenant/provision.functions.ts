import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sbAny } from "@/lib/supabase/untyped";

/**
 * Repairs and returns the signed-in user's first usable organization.
 *
 * `organizationId` is null when the user has deliberately deleted the last one
 * they had. Auto-provisioning in that case used to recreate an identical
 * organization on the very next navigation, which made deleting one look like
 * it had silently rolled back. The caller sends them to create one instead.
 */
export const ensureMyOrganization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { data: userResult, error: userError } = await supabaseAdmin.auth.admin.getUserById(
      context.userId,
    );
    if (userError) throw new Error(userError.message);

    const { data: organizationId, error } = await sbAny(supabaseAdmin).rpc(
      "ensure_personal_organization",
      { _user_id: context.userId, _email: userResult.user?.email ?? undefined },
    );
    if (error) throw new Error(error.message);
    return { organizationId: (organizationId as string | null) ?? null };
  });

const CreateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

/** Creates an organization, its first workspace and the owner's memberships. */
export const createMyOrganization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => CreateOrganizationSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { data: userResult } = await supabaseAdmin.auth.admin.getUserById(context.userId);

    const { data: organizationId, error } = await sbAny(supabaseAdmin).rpc(
      "create_organization_for_user",
      {
        _user_id: context.userId,
        _name: data.name,
        _email: userResult?.user?.email ?? undefined,
      },
    );
    if (error) throw new Error(error.message);
    if (!organizationId) throw new Error("Could not create the organization");
    return { organizationId: organizationId as string };
  });
