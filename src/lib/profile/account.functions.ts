/**
 * Self-serve account deletion.
 *
 * The old client-side flow only renamed the profile to "Deleted user" and
 * signed out, while reporting "Account deleted" — the auth user, the
 * organization, the workspaces and every row they owned survived, and the
 * person could sign straight back in with the same password. This does the
 * real thing, which needs the service role, so it has to live on the server.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sbAny } from "@/lib/supabase/untyped";

const DeleteAccountSchema = z.object({
  /** Must match what the dialog asks the user to type, verified server-side. */
  confirmation: z.literal("delete my account"),
});

export const deleteMyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => DeleteAccountSchema.parse(input))
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");

    // Losing the last superadmin leaves the installation with no way back into
    // the platform surfaces, and the first-run wizard refuses to mint another
    // once an admin has existed.
    const { data: admins, error: adminsError } = await sbAny(supabaseAdmin)
      .from("user_roles")
      .select("user_id")
      .eq("role", "superadmin");
    if (adminsError) throw new Error("Could not verify platform roles");
    const adminIds = (admins ?? []) as Array<{ user_id: string }>;
    if (adminIds.length === 1 && adminIds[0].user_id === context.userId) {
      throw new Error(
        "You are the only super administrator. Grant the role to someone else before deleting your account.",
      );
    }

    // Hands off anything the user owns and clears the foreign keys that are
    // ON DELETE RESTRICT, which would otherwise make the delete below fail.
    const { error: prepareError } = await sbAny(supabaseAdmin).rpc(
      "prepare_platform_user_deletion",
      { _user_id: context.userId },
    );
    if (prepareError)
      throw new Error(`Could not prepare account deletion: ${prepareError.message}`);

    const { error } = await supabaseAdmin.auth.admin.deleteUser(context.userId);
    if (error) throw new Error(error.message);

    return { ok: true };
  });
