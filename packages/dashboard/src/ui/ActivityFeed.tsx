import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { memo, useEffect, useRef } from "react";
import {
  dismissSession,
  setFeedExpanded,
  useDeployment,
  useDismissedSession,
  useFeed,
  useFeedExpanded,
} from "../store.ts";
import { statusColor } from "../theme.ts";

/**
 * Floating deploy feed (bottom-left). Starts minimized: a one-line pill
 * showing the most recent feed event — or "Deployment complete/failed"
 * once the record closes — expanding to the full scrolling log. Dismissing
 * (✕) hides the pill for this deployment version (client-side only).
 * Overlay-aware: viewing a historical version shows ITS feed.
 */
export const ActivityFeed = memo(function ActivityFeed() {
  const deployment = useDeployment();
  const dismissed = useDismissedSession();
  if (deployment === undefined) {
    return null;
  }
  const sessionKey = String(deployment.version);
  if (dismissed === sessionKey) {
    return null;
  }
  return (
    <Feed
      sessionKey={sessionKey}
      live={deployment.live}
      failed={
        deployment.outcome !== undefined && deployment.outcome !== "succeeded"
      }
    />
  );
});

function Feed({
  sessionKey,
  live,
  failed,
}: {
  sessionKey: string;
  live: boolean;
  failed: boolean;
}) {
  const feed = useFeed();
  const expanded = useFeedExpanded();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [feed.version, expanded]);

  const done = !live;
  if (done && feed.entries.length === 0) {
    // an old finished deployment with nothing to show
    return null;
  }

  const latest = feed.entries[feed.entries.length - 1];
  const StatusIcon = done ? (failed ? XCircle : CheckCircle2) : Loader2;
  const statusIconClass = done
    ? failed
      ? "text-red-400"
      : "text-emerald-400"
    : "animate-spin text-amber-400";

  const outcome = failed ? "Deployment failed" : "Deployment complete";
  const title = done
    ? outcome
    : latest
      ? `[${latest.id}] ${latest.text}`
      : "Deploying…";

  return (
    <div
      className={`absolute bottom-4 left-4 z-10 overflow-hidden rounded-xl border border-[#2a2a35] bg-[#101016]/95 backdrop-blur ${
        expanded ? "w-[340px]" : "max-w-[400px]"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusIcon size={14} className={`shrink-0 ${statusIconClass}`} />
        <button
          onClick={() => setFeedExpanded(!expanded)}
          className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-zinc-200 hover:text-white"
          title={expanded ? "Collapse" : title}
        >
          {expanded ? (done ? outcome : "Deploying…") : title}
        </button>
        <button
          onClick={() => setFeedExpanded(!expanded)}
          className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title={expanded ? "Collapse" : "Expand log"}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        <button
          onClick={() => dismissSession(sessionKey)}
          className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
      {expanded && (
        <div
          ref={listRef}
          className="max-h-48 overflow-y-auto border-t border-[#26262f] px-3 py-2"
        >
          {feed.entries.slice(-150).map((entry) => (
            <div key={entry.key} className="flex gap-2 py-0.5 text-[11.5px]">
              <span
                className={`shrink-0 font-medium ${entry.log ? "text-zinc-600" : "text-zinc-400"}`}
              >
                [{entry.id}]
              </span>
              <span
                className="truncate"
                style={{
                  color: entry.log
                    ? "#52525b"
                    : entry.status
                      ? statusColor(entry.status)
                      : "#818cf8",
                }}
                title={entry.text}
              >
                {entry.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
