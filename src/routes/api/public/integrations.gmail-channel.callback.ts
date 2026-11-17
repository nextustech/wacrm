import { createFileRoute } from "@tanstack/react-router";
import { sbAny } from "@/lib/supabase/untyped";

function popupResult(origin: string, success: boolean): Response {
  const payload = JSON.stringify({ type: "wacrm:gmail-channel-oauth", success }).replace(
    /</g,
    "\\u003c",
  );
  const target = JSON.stringify(origin).replace(/</g, "\\u003c");
  const html = `<!doctype html><meta charset="utf-8"><title>Gmail</title><p>${success ? "Gmail account connected. You can close this window." : "Gmail connection failed. Close this window and try again."}</p><script>window.opener?.postMessage(${payload},${target});window.close();</script>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export const Route = createFileRoute("/api/public/integrations/gmail-channel/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const canonical = new URL(process.env.APP_ORIGIN || request.url).origin;
        const query = new URL(request.url).searchParams;
        const state = query.get("state") ?? "";
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(state)) return popupResult(canonical, false);
        const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
        const { data: row, error } = await sbAny(supabaseAdmin)
          .from("integration_oauth_states")
          .delete()
          .eq("state", state)
          .eq("provider_id", "gmail-channel")
          .select("workspace_id,user_id,return_origin,expires_at")
          .maybeSingle();
        if (
          error ||
          !row ||
          new Date(row.expires_at).getTime() < Date.now() ||
          row.return_origin !== canonical
        )
          return popupResult(canonical, false);
        const code = query.get("code");
        if (!code || query.has("error")) return popupResult(canonical, false);
        try {
          const { exchangeGmailChannelCode } =
            await import("@/lib/integrations/google-oauth.server");
          const { encryptToken } = await import("@/lib/instagram/token-crypto.server");
          const { fetchGmailProfile } = await import("@/lib/email/gmail.server");
          const token = await exchangeGmailChannelCode(code, canonical);
          if (!token.refresh_token) throw new Error("Google did not grant offline access");
          const profile = await fetchGmailProfile(token.access_token);

          const db = sbAny(supabaseAdmin);
          const { data: existing, error: lookupError } = await db
            .from("email_accounts")
            .select("id, provider")
            .eq("workspace_id", row.workspace_id)
            .ilike("from_email", profile.emailAddress)
            .maybeSingle();
          if (lookupError) throw new Error(lookupError.message);

          const patch = {
            provider: "gmail",
            display_name: profile.emailAddress,
            from_email: profile.emailAddress,
            oauth_refresh_token_ciphertext: encryptToken(token.refresh_token),
            gmail_history_id: profile.historyId,
            status: "connected",
            status_reason: null,
            connected_by: row.user_id,
            last_verified_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          if (existing) {
            if (existing.provider !== "gmail")
              throw new Error(
                "That address is already connected as a different provider in this workspace.",
              );
            const { error: updateError } = await db
              .from("email_accounts")
              .update(patch)
              .eq("id", existing.id);
            if (updateError) throw new Error(updateError.message);
          } else {
            const { error: insertError } = await db.from("email_accounts").insert({
              workspace_id: row.workspace_id,
              connected_at: new Date().toISOString(),
              ...patch,
            });
            if (insertError) throw new Error(insertError.message);
          }
          return popupResult(canonical, true);
        } catch (cause) {
          console.error("Gmail channel OAuth callback failed", cause);
          return popupResult(canonical, false);
        }
      },
    },
  },
});
