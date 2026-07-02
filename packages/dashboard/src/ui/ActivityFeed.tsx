import { CheckCircle2, Loader2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { LiveApply } from "../live.ts";
import { statusColor } from "../theme.ts";

/**
 * Floating activity feed shown while (and just after) a deploy streams in.
 * Dismissing also clears the session's result overlay (ghost nodes,
 * apply-result badges) — the parent owns that state.
 */
export function ActivityFeed({
  live,
  onDismiss,
}: {
  live: LiveApply;
  onDismiss: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [live.feed.length]);

  return (
    <div className="absolute bottom-4 left-4 z-10 w-[340px] overflow-hidden rounded-xl border border-[#2a2a35] bg-[#101016]/95 backdrop-blur">
      <div className="flex items-center gap-2 border-b border-[#26262f] px-3 py-2">
        {live.done ? (
          <CheckCircle2 size={14} className="text-emerald-400" />
        ) : (
          <Loader2 size={14} className="animate-spin text-amber-400" />
        )}
        <span className="text-[12px] font-medium text-zinc-200">
          {live.done ? "Deploy complete" : "Deploying…"}
        </span>
        <button
          onClick={onDismiss}
          className="ml-auto rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <X size={12} />
        </button>
      </div>
      <div ref={listRef} className="max-h-48 overflow-y-auto px-3 py-2">
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
    </div>
  );
}
