import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, RefreshCw, ShieldCheck, AlertTriangle, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrentWorkspace } from "@/hooks/use-workspace";
import {
  connectLineAccount,
  deleteLineAccount,
  listLineAccounts,
  verifyLineAccount,
  type LineAccountSummary,
} from "@/lib/line/accounts.functions";

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
    hint: "Access token valid and the webhook points at this app. Sending is enabled.",
    variant: "secondary",
    dot: "bg-emerald-500",
  },
  token_invalid: {
    label: "Token invalid",
    hint: "LINE rejected the stored channel access token. Issue a new one in the LINE Developers Console and reconnect.",
    variant: "destructive",
    dot: "bg-destructive",
  },
  webhook_not_set: {
    label: "Webhook not set",
    hint: "The token works, but LINE is not delivering events here. Run Verify to re-register the endpoint.",
    variant: "outline",
    dot: "bg-amber-500",
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

export function LineAccountsPanel() {
  const { data: ws } = useCurrentWorkspace();
  const workspaceId = ws?.id ?? null;
  const qc = useQueryClient();
  const [secret, setSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");

  const accountsQuery = useQuery({
    queryKey: ["line-accounts", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const res = await listLineAccounts({ data: { workspaceId: workspaceId as string } });
      return res.accounts as LineAccountSummary[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["line-accounts", workspaceId] });

  const connect = useMutation({
    mutationFn: async () =>
      connectLineAccount({
        data: {
          workspaceId: workspaceId as string,
          channelSecret: secret.trim(),
          channelAccessToken: accessToken.trim(),
          origin: origin(),
        },
      }),
    onSuccess: (res) => {
      setSecret("");
      setAccessToken("");
      void invalidate();
      toast.success(
        res.alreadyConnected
          ? `Refreshed ${res.displayName ?? "the LINE account"}`
          : `Connected ${res.displayName ?? "the LINE account"}`,
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const verify = useMutation({
    mutationFn: async (accountId: string) =>
      verifyLineAccount({ data: { accountId, origin: origin() } }),
    onSuccess: () => {
      void invalidate();
      toast.success("Webhook verified");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: async (accountId: string) => deleteLineAccount({ data: { accountId } }),
    onSuccess: () => {
      void invalidate();
      toast.success("LINE account disconnected");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const accounts = accountsQuery.data ?? [];
  const canConnect = secret.trim().length >= 16 && accessToken.trim().length >= 40;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Connect a LINE Official Account</CardTitle>
          <CardDescription>
            In the LINE Developers Console open your Messaging API channel and copy both values.
            The channel secret verifies inbound webhooks; the access token authorises replies.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="line-secret">Channel secret</Label>
              <Input
                id="line-secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Basic settings → Channel secret"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="line-token">Channel access token (long-lived)</Label>
              <Input
                id="line-token"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="Messaging API → Channel access token"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Also turn <span className="font-medium">Use webhook</span> on, and switch off
            <span className="font-medium"> Auto-reply messages</span> in the LINE Official Account
            Manager — otherwise LINE answers before this app does.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => connect.mutate()} disabled={!workspaceId || !canConnect || connect.isPending}>
              {connect.isPending ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Connect account
            </Button>
            <Button variant="ghost" asChild>
              <a href="https://developers.line.biz/console/" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" /> Open LINE Developers Console
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected accounts</CardTitle>
          <CardDescription>
            Verify re-checks the token and re-points the webhook endpoint if it has drifted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {accountsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No LINE account connected yet.</p>
          ) : (
            <ul className="divide-y rounded-control border">
              {accounts.map((a) => {
                const meta = statusMeta(a.status);
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 p-3">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {a.display_name ?? "LINE account"}
                        </span>
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.basic_id ?? a.bot_user_id}
                      </p>
                      {a.status_reason ? (
                        <p className="mt-1 flex items-start gap-1 text-xs text-destructive">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {a.status_reason}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">{meta.hint}</p>
                      )}
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
