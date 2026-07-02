import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LiveApply } from "../live.ts";
import { statusColor } from "../theme.ts";

/**
 * Floating deploy feed. Starts minimized: a one-line pill showing the most
 * recent event (or the final outcome once done); expands to the full
 * scrolling log. Dismissing (✕) also clears the session's result overlay
 * (ghost nodes, apply-result badges) — the parent owns that state.
 */
export function ActivityFeed({
  live,
  onDismiss,
}: {
  live: LiveApply;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [live.feed.length, expanded]);

  const failed =
    [...live.results.values()].some((r) => r.result === "failed") ||
    live.feed.some((e) => e.status === "fail");
  const latest = live.feed[live.feed.length - 1];

  const StatusIcon = live.done ? (failed ? XCircle : CheckCircle2) : Loader2;
  const statusIconClass = live.done
    ? failed
      ? "text-red-400"
      : "text-emerald-400"
    : "animate-spin text-amber-400";

  const title = live.done
    ? failed
      ? "Deployment failed"
      : "Deployment complete"
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
          onClick={() => setExpanded((e) => !e)}
          className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-zinc-200 hover:text-white"
          title={expanded ? "Collapse" : title}
        >
          {expanded
            ? live.done
              ? failed
                ? "Deployment failed"
                : "Deployment complete"
              : "Deploying…"
            : title}
        </button>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title={expanded ? "Collapse" : "Expand log"}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        <button
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="Dismiss (clears deploy annotations)"
        >
          <X size={12} />
        </button>
      </div>
      {expanded && (
        <div
          ref={listRef}
          className="max-h-48 overflow-y-auto border-t border-[#26262f] px-3 py-2"
        >
          {live.feed.slice(-150).map((entry) => (
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
