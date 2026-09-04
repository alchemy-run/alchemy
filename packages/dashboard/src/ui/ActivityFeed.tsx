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

/**
 * The expanded log renders on the walnut code surface, where the semantic
 * page tokens sink — remap `statusColor`'s output onto the syntax palette
 * (tuned for walnut in both themes) instead.
 */
const WALNUT_STATUS_COLORS: Record<string, string> = {
  "var(--alc-success)": "var(--alc-code-keyword)",
  "var(--alc-warn)": "var(--alc-code-string)",
  "var(--alc-danger)": "var(--alc-code-literal)",
  "var(--alc-muted)": "var(--alc-code-comment)",
};

const walnutStatusColor = (status: string): string =>
  WALNUT_STATUS_COLORS[statusColor(status)] ?? "var(--alc-code-type)";

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
      ? "text-[var(--alc-danger)]"
      : "text-[var(--alc-success)]"
    : "animate-spin text-[var(--alc-warn)]";

  const outcome = failed ? "Deployment failed" : "Deployment complete";
  const title = done
    ? outcome
    : latest
      ? `[${latest.id}] ${latest.text}`
      : "Deploying…";

  return (
    <div
      className={`absolute bottom-4 left-4 z-10 overflow-hidden rounded-[var(--alc-radius-lg)] border border-[var(--alc-hairline-2)] bg-[var(--alc-bg-elev-2)]/95 shadow-[var(--alc-shadow)] backdrop-blur ${
        expanded ? "w-[340px]" : "max-w-[400px]"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusIcon size={14} className={`shrink-0 ${statusIconClass}`} />
        <button
          onClick={() => setFeedExpanded(!expanded)}
          className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] font-medium text-[var(--alc-fg-1)] transition-colors duration-[var(--alc-dur-fast)] hover:text-[var(--alc-accent-deep)]"
          title={expanded ? "Collapse" : title}
        >
          {expanded ? (done ? outcome : "Deploying…") : title}
        </button>
        <button
          onClick={() => setFeedExpanded(!expanded)}
          className="shrink-0 rounded-[var(--alc-radius-sm)] p-0.5 text-[var(--alc-fg-4)] transition-colors duration-[var(--alc-dur-fast)] hover:bg-[var(--alc-bg-sunk)] hover:text-[var(--alc-fg-1)]"
          title={expanded ? "Collapse" : "Expand log"}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        <button
          onClick={() => dismissSession(sessionKey)}
          className="shrink-0 rounded-[var(--alc-radius-sm)] p-0.5 text-[var(--alc-fg-4)] transition-colors duration-[var(--alc-dur-fast)] hover:bg-[var(--alc-bg-sunk)] hover:text-[var(--alc-fg-1)]"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
      {expanded && (
        <div
          ref={listRef}
          className="max-h-48 overflow-y-auto border-t border-[var(--alc-hairline)] bg-[var(--alc-bg-code)] px-3 py-2"
        >
          {feed.entries.slice(-150).map((entry) => (
            <div
              key={entry.key}
              className="flex gap-2 py-0.5 font-mono text-[11px]"
            >
              <span
                className={`shrink-0 font-medium ${
                  entry.log
                    ? "text-[var(--alc-code-comment)]"
                    : "text-[var(--alc-fg-invert)]"
                }`}
              >
                [{entry.id}]
              </span>
              <span
                className="truncate"
                style={{
                  color: entry.log
                    ? "var(--alc-code-comment)"
                    : entry.status
                      ? walnutStatusColor(entry.status)
                      : "var(--alc-code-type)",
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
