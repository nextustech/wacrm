import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, RefreshCw, ShieldCheck, AlertTriangle, ExternalLink, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrentWorkspace } from "@/hooks/use-workspace";
import {
  connectWeChatAccount,
  deleteWeChatAccount,
  listWeChatAccounts,
  verifyWeChatAccount,
  type WeChatAccountSummary,
} from "@/lib/wechat/accounts.functions";

function origin() {
  return typeof window !== "undefined" ? window.location.origin : "";
}

type StatusMeta = {
  label: string;
  hint: string;
  variant: "secondary" | "destructive" | "outline";
  dot: string;
};

const STATUS_META: Record<string, StatusMeta> = {
  connected: {
    label: "Connected",
    hint: "Credentials valid and WeChat has reached this app's webhook.",
    variant: "secondary",
    dot: "bg-emerald-500",
  },
  pending_webhook: {
    label: "Awaiting webhook",
    hint: "Credentials are valid. Paste the URL below as the Server Address in the WeChat MP console and press Submit there.",
    variant: "outline",
    dot: "bg-amber-500",
  },
  token_invalid: {
    label: "Credentials invalid",
    hint: "WeChat rejected the AppID/AppSecret. Check them, and that this server's IP is on the account's allowlist.",
    variant: "destructive",
    dot: "bg-destructive",
  },
};

function statusMeta(status: string): StatusMeta {
  return (
    STATUS_META[status] ?? {
      label: status || "Unknown",
      hint: "Connection state could not be confirmed. Run Verify to refresh it.",
      variant: "destructive",
      dot: "bg-destructive",
    }
  );
}

export function WeChatAccountsPanel() {
  const { data: ws } = useCurrentWorkspace();
  const workspaceId = ws?.id ?? null;
  const qc = useQueryClient();
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [accountName, setAccountName] = useState("");

  const accountsQuery = useQuery({
    queryKey: ["wechat-accounts", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const res = await listWeChatAccounts({ data: { workspaceId: workspaceId as string } });
      return res.accounts as WeChatAccountSummary[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["wechat-accounts", workspaceId] });

  const connect = useMutation({
    mutationFn: async () =>
      connectWeChatAccount({
        data: {
          workspaceId: workspaceId as string,
          appId: appId.trim(),
          appSecret: appSecret.trim(),
          webhookToken: webhookToken.trim(),
          ...(accountName.trim() ? { accountName: accountName.trim() } : {}),
          origin: origin(),
        },
      }),
    onSuccess: (res) => {
      setAppSecret("");
      void invalidate();
      void navigator.clipboard?.writeText(res.webhookUrl).catch(() => {});
      toast.success("Credentials verified — webhook URL copied to clipboard");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const verify = useMutation({
    mutationFn: async (accountId: string) =>
      verifyWeChatAccount({ data: { accountId, origin: origin() } }),
    onSuccess: (res) => {
      void invalidate();
      toast.success(
        res.ok ? "WeChat account verified" : "Credentials fine — waiting for the console check",
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: async (accountId: string) => deleteWeChatAccount({ data: { accountId } }),
    onSuccess: () => {
      void invalidate();
      toast.success("WeChat account disconnected");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const accounts = accountsQuery.data ?? [];
  const canConnect =
    appId.trim().length >= 10 && appSecret.trim().length >= 16 && webhookToken.trim().length >= 3;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Connect a WeChat Official Account</CardTitle>
          <CardDescription>
            Setup is two-sided: paste the credentials here, then enter the generated URL and the
            same Token in the WeChat MP console under Basic Configuration.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="wechat-appid">AppID</Label>
              <Input
                id="wechat-appid"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="wx0123456789abcdef"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wechat-secret">AppSecret</Label>
              <Input
                id="wechat-secret"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder="Basic Configuration → AppSecret"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wechat-token">Token</Label>
              <Input
                id="wechat-token"
                value={webhookToken}
                onChange={(e) => setWebhookToken(e.target.value)}
                placeholder="3–32 letters and digits — you choose this"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wechat-name">Account name (optional)</Label>
              <Input
                id="wechat-name"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                placeholder="Shown in the Inbox account picker"
              />
            </div>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>Message mode must be <span className="font-medium">plaintext</span> — encrypted (safe) mode is not supported yet.</li>
            <li>Add this server&apos;s outbound IP to the account&apos;s IP allowlist, or WeChat refuses every API call.</li>
            <li>Replies are only allowed within 48 hours of the customer&apos;s last message.</li>
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => connect.mutate()} disabled={!workspaceId || !canConnect || connect.isPending}>
              {connect.isPending ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Verify credentials
            </Button>
            <Button variant="ghost" asChild>
              <a href="https://mp.weixin.qq.com/" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" /> Open WeChat MP console
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected accounts</CardTitle>
          <CardDescription>
            An account turns green the moment WeChat&apos;s console check reaches the webhook URL.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {accountsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No WeChat account connected yet.</p>
          ) : (
            <ul className="divide-y rounded-control border">
              {accounts.map((a) => {
                const meta = statusMeta(a.status);
                const webhookUrl = `${origin()}/api/public/webhooks/wechat/${a.id}`;
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 p-3">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {a.account_name ?? "WeChat account"}
                        </span>
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{a.app_id}</p>
                      {a.status_reason ? (
                        <p className="mt-1 flex items-start gap-1 text-xs text-destructive">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {a.status_reason}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">{meta.hint}</p>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard?.writeText(webhookUrl);
                          toast.success("Webhook URL copied");
                        }}
                        className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline"
                      >
                        <Copy className="h-3 w-3" /> Copy Server Address (URL)
                      </button>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => verify.mutate(a.id)}
                        disabled={verify.isPending}
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${verify.isPending ? "animate-spin" : ""}`}
                        />
                        Verify
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => remove.mutate(a.id)}
                        disabled={remove.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
