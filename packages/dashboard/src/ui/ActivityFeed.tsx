import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { statusColor } from "../theme.ts";
import type { SceneSession } from "../types.ts";

/**
 * Floating deploy feed. Starts minimized: a one-line pill showing the most
 * recent event (or the final outcome once done); expands to the full
 * scrolling log. Dismissing (✕) hides the pill for this session — the
 * scene's node annotations live server-side and retire when the next
 * operation begins.
 */
export function ActivityFeed({
  session,
  onDismiss,
}: {
  session: SceneSession;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [session.feed.length, expanded]);

  const latest = session.feed[session.feed.length - 1];

  const StatusIcon = session.done
    ? session.failed
      ? XCircle
      : CheckCircle2
    : Loader2;
  const statusIconClass = session.done
    ? session.failed
      ? "text-red-400"
      : "text-emerald-400"
    : "animate-spin text-amber-400";

  const outcome = session.failed ? "Deployment failed" : "Deployment complete";
  const title = session.done
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
          onClick={() => setExpanded((e) => !e)}
          className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-zinc-200 hover:text-white"
          title={expanded ? "Collapse" : title}
        >
          {expanded ? (session.done ? outcome : "Deploying…") : title}
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
          {session.feed.slice(-150).map((entry) => (
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
