/**
 * Email sender accounts — connect the identity the workspace sends from and
 * (optionally) the inbound address replies arrive on. Connected accounts show
 * up in the Inbox account selector and conversations link to them.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Trash2, Power, PowerOff, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrentWorkspace } from "@/hooks/use-workspace";
import {
  connectEmailAccount,
  deleteEmailAccount,
  getEmailWebhookInfo,
  listEmailAccounts,
  startGmailChannelOAuth,
  updateEmailAccount,
  type EmailAccountSummary,
} from "@/lib/email/accounts.functions";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "connected") return <Badge variant="secondary">Connected</Badge>;
  if (status === "error") return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="outline">{status === "disconnected" ? "Disabled" : "Pending"}</Badge>;
}

export function EmailAccountsPanel() {
  const { data: ws } = useCurrentWorkspace();
  const workspaceId = ws?.id ?? undefined;
  const qc = useQueryClient();

  const [displayName, setDisplayName] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [inboundAddress, setInboundAddress] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [webhook, setWebhook] = useState<{ id: string; url: string } | null>(null);

  const accountsQuery = useQuery({
    queryKey: ["email-accounts", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () =>
      (await listEmailAccounts({ data: { workspaceId: workspaceId! } })).accounts,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["email-accounts", workspaceId] });
    void qc.invalidateQueries({ queryKey: ["external-channel-accounts", workspaceId] });
  };

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if ((event.data as { type?: string } | null)?.type !== "wacrm:gmail-channel-oauth") return;
      if ((event.data as { success?: boolean }).success) {
        toast.success("Gmail account connected");
        invalidate();
      } else {
        toast.error("Gmail connection failed");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const connectGmail = useMutation({
    mutationFn: async () =>
      startGmailChannelOAuth({
        data: { workspaceId: workspaceId!, targetOrigin: window.location.origin },
      }),
    onSuccess: (res) => {
      window.open(res.authorizationUrl, "wacrm-gmail-oauth", "width=480,height=640");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const connect = useMutation({
    mutationFn: async () =>
      connectEmailAccount({
        data: {
          workspaceId: workspaceId!,
          displayName: displayName.trim(),
          fromEmail: fromEmail.trim(),
          fromName: fromName.trim() || null,
          replyTo: replyTo.trim() || null,
          inboundAddress: inboundAddress.trim() || null,
          provider: "resend",
          apiKey: apiKey.trim(),
        },
      }),
    onSuccess: (res) => {
      toast.success("Email account connected");
      if (res.webhookUrlPath) {
        setWebhook({ id: res.account.id, url: `${window.location.origin}${res.webhookUrlPath}` });
      }
      setApiKey("");
      setDisplayName("");
      setFromEmail("");
      setFromName("");
      setReplyTo("");
      setInboundAddress("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: async (a: EmailAccountSummary) =>
      updateEmailAccount({
        data: { id: a.id, status: a.status === "connected" ? "disconnected" : "connected" },
      }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const showWebhook = useMutation({
    mutationFn: async (id: string) => ({ id, ...(await getEmailWebhookInfo({ data: { id } })) }),
    onSuccess: (r) => setWebhook({ id: r.id, url: `${window.location.origin}${r.webhookUrlPath}` }),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => deleteEmailAccount({ data: { id } }),
    onSuccess: () => {
      toast.success("Email account removed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSubmit =
    !!workspaceId &&
    displayName.trim().length > 0 &&
    /\S+@\S+\.\S+/.test(fromEmail) &&
    apiKey.trim().length > 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" /> Connect an email account
          </CardTitle>
          <CardDescription>
            Outgoing mail is sent through Resend from your verified domain. To receive mail, enable
            Receiving for that domain in Resend and add the webhook URL shown after connecting. Or
            connect a Gmail mailbox directly below — no DNS setup required.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Button
              variant="outline"
              disabled={!workspaceId || connectGmail.isPending}
              onClick={() => connectGmail.mutate()}
            >
              {connectGmail.isPending ? "Opening Google sign-in" : "Connect Gmail"}
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">
              Grants read + send access only (no Drive, Calendar, or Contacts). You can revoke it
              from Google at any time.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ea-name">Account name</Label>
            <Input
              id="ea-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Support mailbox"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ea-from">From address</Label>
            <Input
              id="ea-from"
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="support@yourdomain.com"
              maxLength={255}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ea-fromname">From name (optional)</Label>
            <Input
              id="ea-fromname"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Support"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ea-reply">Reply-to (optional)</Label>
            <Input
              id="ea-reply"
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="team@yourdomain.com"
              maxLength={255}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="ea-inbound">Inbound address (optional)</Label>
            <Input
              id="ea-inbound"
              type="email"
              value={inboundAddress}
              onChange={(e) => setInboundAddress(e.target.value)}
              placeholder="inbox@yourdomain.com"
              maxLength={255}
            />
            <p className="text-xs text-muted-foreground">
              Replies arriving on this address are matched to this account and routed into the
              Inbox.
            </p>
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="ea-apikey">Resend API key</Label>
            <Input
              id="ea-apikey"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="re_..."
              maxLength={400}
            />
            <p className="text-xs text-muted-foreground">
              Stored encrypted. It is first verified when the first email is sent.
            </p>
          </div>
          <p className="text-xs text-muted-foreground md:col-span-2">
            Domain verification happens in Resend and your DNS provider. Copy each MX/TXT record
            exactly as Resend shows it. If your DNS provider rejects <code>@</code> for a root
            record, use its blank or root-domain host setting instead. A partially verified domain
            can send while Receiving is still unverified; check the failed record in Resend before
            expecting inbound messages.
          </p>
          <div className="md:col-span-2">
            <Button disabled={!canSubmit || connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? "Connecting" : "Connect account"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected email accounts</CardTitle>
          <CardDescription>Accounts available to the omnichannel Inbox.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {accountsQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Loading accounts</p>
          )}
          {!accountsQuery.isLoading && (accountsQuery.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No email accounts connected yet.</p>
          )}
          {(accountsQuery.data ?? []).map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{a.display_name}</span>
                  <StatusBadge status={a.status} />
                  {a.provider === "gmail" && <Badge variant="outline">Gmail</Badge>}
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {a.from_email}
                  {a.inbound_address ? ` · inbound: ${a.inbound_address}` : ""}
                  {a.provider === "gmail" ? ` · last synced: ${timeAgo(a.last_synced_at)}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {a.provider === "resend" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={showWebhook.isPending}
                    onClick={() => showWebhook.mutate(a.id)}
                  >
                    <Link2 className="mr-1 h-4 w-4" /> Webhook URL
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate(a)}
                >
                  {a.status === "connected" ? (
                    <>
                      <PowerOff className="mr-1 h-4 w-4" /> Disable
                    </>
                  ) : (
                    <>
                      <Power className="mr-1 h-4 w-4" /> Enable
                    </>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(a.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {webhook?.id === a.id && (
                <div className="w-full space-y-1 rounded bg-muted p-2">
                  <p className="text-xs text-muted-foreground">
                    Inbound webhook (keep it secret; it contains the token):
                  </p>
                  <code className="block break-all text-xs">{webhook.url}</code>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
