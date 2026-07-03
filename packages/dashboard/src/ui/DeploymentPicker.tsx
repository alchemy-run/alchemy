import { Check, ChevronDown, History, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { loadDeployments, selectDeployment } from "../ingest.ts";
import { useHistory, type DeploymentRecord } from "../store.ts";
import { formatRelative, useNow } from "../format.ts";

const outcomeColor = (record: DeploymentRecord): string => {
  if (record.endedAt === undefined) {
    return "#fbbf24"; // still open / heartbeating
  }
  switch (record.outcome) {
    case "succeeded":
      return "#34d399";
    case "failed":
      return "#f87171";
    default:
      return "#fbbf24"; // interrupted / abandoned / completed-late
  }
};

const initiatorOf = (record: DeploymentRecord): string | undefined => {
  const initiator = record.meta.initiator;
  if (initiator === undefined) {
    return undefined;
  }
  if (initiator.user !== undefined && initiator.host !== undefined) {
    return `${initiator.user}@${initiator.host}`;
  }
  return initiator.user ?? initiator.host;
};

/**
 * Deployment history dropdown: pick any past version to overlay its
 * decorations/timelines/op-spans onto the SAME live structure (zero graph
 * movement), or "Live" to return to the streaming document.
 */
export function DeploymentPicker() {
  const history = useHistory();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(30_000, open);

  useEffect(() => {
    if (!open) {
      return;
    }
    // refresh the list every time the picker opens
    void loadDeployments();
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const choose = (version: number | "live") => {
    void selectDeployment(version);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-[#2a2a35] px-2.5 py-1 text-[12px] text-zinc-400 hover:border-[#3a3a48] hover:text-zinc-200"
        title="Deployment history"
      >
        <History size={13} />
        {history.selected === "live" ? "history" : `v${history.selected}`}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-72 overflow-hidden rounded-xl border border-[#2a2a35] bg-[#15151c] shadow-xl shadow-black/40">
          <div className="max-h-80 overflow-y-auto py-1">
            <button
              onClick={() => choose("live")}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-zinc-200 hover:bg-[#1c1c24]"
            >
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
              Live
              <span className="ml-auto w-3">
                {history.selected === "live" && (
                  <Check size={12} className="text-indigo-400" />
                )}
              </span>
            </button>
            {history.deployments.map((record) => {
              const initiator = initiatorOf(record);
              return (
                <button
                  key={record.version}
                  onClick={() => choose(record.version)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-zinc-300 hover:bg-[#1c1c24]"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: outcomeColor(record) }}
                    title={record.outcome ?? "in progress"}
                  />
                  <span className="font-medium text-zinc-200">
                    v{record.version}
                  </span>
                  <span className="text-zinc-500">{record.meta.command}</span>
                  <span className="ml-auto flex flex-col items-end">
                    <span className="text-[11px] text-zinc-500">
                      {formatRelative(record.startedAt, now)}
                    </span>
                    {initiator && (
                      <span className="max-w-32 truncate text-[10.5px] text-zinc-600">
                        {initiator}
                      </span>
                    )}
                  </span>
                  <span className="w-3">
                    {history.selected === record.version && (
                      <Check size={12} className="text-indigo-400" />
                    )}
                  </span>
                </button>
              );
            })}
            {history.loading && history.deployments.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-zinc-600">loading…</p>
            )}
            {!history.loading &&
              history.deployments.length === 0 &&
              history.error === undefined && (
                <p className="px-3 py-2 text-[11px] text-zinc-600">
                  no recorded deployments
                </p>
              )}
            {history.error !== undefined && (
              <p className="px-3 py-2 text-[11px] text-red-400">
                {history.error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "viewing vN (historical)" indicator with a one-click return to Live. */
export function HistoricalPill() {
  const history = useHistory();
  if (history.selected === "live") {
    return null;
  }
  return (
    <button
      onClick={() => void selectDeployment("live")}
      className="flex items-center gap-1.5 rounded-full bg-purple-500/15 px-2.5 py-0.5 text-[11px] font-medium text-purple-300 hover:bg-purple-500/25"
      title="Return to the live document"
    >
      viewing v{history.selected} (historical)
      <X size={11} />
    </button>
  );
}
