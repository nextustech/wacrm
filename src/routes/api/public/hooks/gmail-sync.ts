/**
 * Public cron endpoint — Gmail inbox channel polling sync.
 * Called by pg_cron every 3 minutes. Authenticated via private x-cron-token header (INTERNAL_CRON_TOKEN).
 */
import { createFileRoute } from "@tanstack/react-router";
import { guardCronRequest } from "@/lib/api/request-guards";
import { syncGmailAccount, type GmailAccountRow } from "@/lib/email/gmail-sync.server";

export const Route = createFileRoute("/api/public/hooks/gmail-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = guardCronRequest(request);
        if (denied) return denied;
        const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
        try {
          const { data: rows, error } = await supabaseAdmin
            .from("email_accounts")
            .select(
              "id, workspace_id, provider, display_name, from_email, from_name, reply_to, status, oauth_refresh_token_ciphertext, gmail_history_id",
            )
            .eq("provider", "gmail")
            .eq("status", "connected");
          if (error) throw new Error(error.message);
          const accounts = (rows ?? []) as unknown as GmailAccountRow[];
          const results = [];
          for (const account of accounts) {
            results.push(await syncGmailAccount(supabaseAdmin, account));
          }
          return Response.json({ ok: true, accounts: results.length, results });
        } catch (e) {
          console.error("gmail-sync failed:", e);
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
            { status: 500 },
          );
        }
      },
      GET: async () => Response.json({ ok: true, hint: "POST to run sync" }),
    },
  },
});
