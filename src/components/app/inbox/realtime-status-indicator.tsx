import { Bell, BellOff, CircleDot, WifiOff, RefreshCcw, CloudUpload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useRealtimeMessaging } from "@/hooks/use-realtime-messaging";

export function RealtimeStatusIndicator({
  className,
  flat = false,
}: {
  className?: string;
  /** Borderless, full-width stacked rows for use inside a menu/panel, instead
   * of the default compact chip meant for a toolbar. */
  flat?: boolean;
}) {
  const {
    connectionState,
    onlineUsers,
    notificationsPermission,
    requestDesktopNotifications,
    pendingOfflineCount,
  } = useRealtimeMessaging();

  const onlineCount = Object.keys(onlineUsers).length;

  const dot =
    connectionState === "connected"
      ? "bg-emerald-500"
      : connectionState === "reconnecting"
      ? "bg-amber-500 animate-pulse"
      : connectionState === "offline"
      ? "bg-destructive"
      : connectionState === "paused"
      ? "bg-muted-foreground"
      : "bg-muted-foreground animate-pulse";

  const label =
    connectionState === "connected"
      ? "Live"
      : connectionState === "reconnecting"
      ? "Reconnecting"
      : connectionState === "offline"
      ? "Offline"
      : connectionState === "paused"
      ? "Realtime off"
      : "Connecting";

  const Icon =
    connectionState === "offline" || connectionState === "paused"
      ? WifiOff
      : connectionState === "reconnecting"
      ? RefreshCcw
      : CircleDot;

  const showNotificationRow =
    notificationsPermission !== "unsupported" && notificationsPermission !== "granted";

  if (flat) {
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <div className="flex items-center gap-2 text-xs">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className={cn("absolute inset-0 rounded-full opacity-60", dot)} />
            <span className={cn("relative h-2 w-2 rounded-full", dot)} />
          </span>
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{label}</span>
          {onlineCount > 0 && connectionState === "connected" && (
            <span className="text-muted-foreground">
              · {onlineCount} teammate{onlineCount === 1 ? "" : "s"} online
            </span>
          )}
        </div>

        {pendingOfflineCount > 0 && (
          <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <CloudUpload className="h-3.5 w-3.5 shrink-0" />
            <span>{pendingOfflineCount} message{pendingOfflineCount === 1 ? "" : "s"} queued for retry</span>
          </div>
        )}

        {showNotificationRow && (
          <button
            type="button"
            onClick={() => void requestDesktopNotifications()}
            className="flex items-center gap-2 rounded-sm px-1 py-1 -mx-1 text-xs text-muted-foreground hover:bg-muted  hover:text-accent-foreground"
          >
            {notificationsPermission === "denied" ? (
              <BellOff className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Bell className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>
              {notificationsPermission === "denied"
                ? "Notifications blocked in browser"
                : "Enable desktop notifications"}
            </span>
          </button>
        )}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn("flex items-center gap-1.5", className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 rounded-control border border-border bg-background/60 px-2 py-1 text-xs font-medium">
              <span className={cn("relative flex h-2 w-2")}>
                <span
                  className={cn(
                    "absolute inset-0 rounded-full opacity-60",
                    dot,
                  )}
                />
                <span className={cn("relative rounded-full h-2 w-2", dot)} />
              </span>
              <Icon className="h-3 w-3 text-muted-foreground" />
              <span>{label}</span>
              {onlineCount > 0 && connectionState === "connected" && (
                <span className="text-muted-foreground">· {onlineCount}</span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            <div className="font-medium">{label}</div>
            <div className="text-white/80">
              {onlineCount} teammate{onlineCount === 1 ? "" : "s"} online
            </div>
          </TooltipContent>
        </Tooltip>

        {pendingOfflineCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 rounded-control border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                <CloudUpload className="h-3 w-3" />
                {pendingOfflineCount}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {pendingOfflineCount} queued for retry
            </TooltipContent>
          </Tooltip>
        )}

        {showNotificationRow && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void requestDesktopNotifications()}
                aria-label="Enable desktop notifications"
              >
                {notificationsPermission === "denied" ? (
                  <BellOff className="h-3.5 w-3.5" />
                ) : (
                  <Bell className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {notificationsPermission === "denied"
                ? "Notifications blocked in browser"
                : "Enable desktop notifications"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
