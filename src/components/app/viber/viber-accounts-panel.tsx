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
  connectViberBot,
  deleteViberAccount,
  listViberAccounts,
  verifyViberAccount,
  type ViberAccountSummary,
} from "@/lib/viber/accounts.functions";

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
    hint: "Auth token valid and the webhook points at this app. Sending is enabled.",
    variant: "secondary",
    dot: "bg-emerald-500",
  },
  token_invalid: {
    label: "Token invalid",
    hint: "Viber rejected the stored auth token. Reconnect with a fresh token from the Viber Admin Panel.",
    variant: "destructive",
    dot: "bg-destructive",
  },
  webhook_not_set: {
    label: "Webhook not set",
    hint: "The token works, but Viber is not delivering events here. Run Verify to re-register the webhook.",
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

export function ViberAccountsPanel() {
  const { data: ws } = useCurrentWorkspace();
  const workspaceId = ws?.id ?? null;
  const qc = useQueryClient();
  const [token, setToken] = useState("");

  const accountsQuery = useQuery({
    queryKey: ["viber-accounts", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const res = await listViberAccounts({ data: { workspaceId: workspaceId as string } });
      return res.accounts as ViberAccountSummary[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["viber-accounts", workspaceId] });

  const connect = useMutation({
    mutationFn: async () =>
      connectViberBot({
        data: {
          workspaceId: workspaceId as string,
          authToken: token.trim(),
          origin: origin(),
        },
      }),
    onSuccess: (res) => {
      setToken("");
      void invalidate();
      toast.success(
        res.alreadyConnected
          ? `Refreshed ${res.botName ?? "the Viber bot"}`
          : `Connected ${res.botName ?? "the Viber bot"}`,
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const verify = useMutation({
    mutationFn: async (accountId: string) =>
      verifyViberAccount({ data: { accountId, origin: origin() } }),
    onSuccess: () => {
      void invalidate();
      toast.success("Webhook verified");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: async (accountId: string) => deleteViberAccount({ data: { accountId } }),
    onSuccess: () => {
      void invalidate();
      toast.success("Viber bot disconnected");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const accounts = accountsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Connect a Viber bot</CardTitle>
          <CardDescription>
            Create a bot in the Viber Admin Panel, then paste its auth token here. We validate the
            token, register the webhook for this workspace, and store the token encrypted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="viber-token">Bot auth token</Label>
            <Input
              id="viber-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="4e6f1a2b3c4d5e6f-a1b2c3d4e5f60718-293a4b5c6d7e8f90"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Viber Admin Panel → your bot → Info → Token. The bot must be published before it can
              receive messages.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => connect.mutate()}
              disabled={!workspaceId || token.trim().length < 20 || connect.isPending}
            >
              {connect.isPending ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Connect bot
            </Button>
            <Button variant="ghost" asChild>
              <a href="https://partners.viber.com/" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" /> Open Viber Admin Panel
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected bots</CardTitle>
          <CardDescription>
            Each bot has its own webhook URL. Verify re-checks the token and re-registers the
            webhook if it has drifted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {accountsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Viber bot connected yet.</p>
          ) : (
            <ul className="divide-y rounded-control border">
              {accounts.map((a) => {
                const meta = statusMeta(a.status);
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 p-3">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{a.bot_name ?? "Viber bot"}</span>
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.bot_uri ? `viber.com/${a.bot_uri}` : a.bot_id}
                      </p>
                      {a.status_reason && (
                        <p className="mt-1 flex items-start gap-1 text-xs text-destructive">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {a.status_reason}
                        </p>
                      )}
                      {!a.status_reason && (
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
