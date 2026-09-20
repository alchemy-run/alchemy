import { Check, ChevronDown, History, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { loadDeployments, selectDeployment } from "../ingest.ts";
import { useHistory, type DeploymentRecord } from "../store.ts";
import { formatRelative, useNow } from "../format.ts";
import {
  CHIP,
  chipStyle,
  HAIRLINE_BUTTON,
  MENU_ITEM,
  PANEL,
} from "../theme.ts";

const outcomeColor = (record: DeploymentRecord): string => {
  if (record.endedAt === undefined) {
    return "var(--alc-warn)"; // still open / heartbeating
  }
  switch (record.outcome) {
    case "succeeded":
      return "var(--alc-success)";
    case "failed":
      return "var(--alc-danger)";
    default:
      return "var(--alc-warn)"; // interrupted / abandoned / completed-late
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
        className={`${HAIRLINE_BUTTON} flex items-center gap-1.5 px-2.5 py-1 text-[12px]`}
        title="Deployment history"
      >
        <History size={13} />
        {history.selected === "live" ? (
          "history"
        ) : (
          <span className="font-mono">v{history.selected}</span>
        )}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          className={`${PANEL} absolute right-0 top-9 z-30 w-72 overflow-hidden`}
        >
          <div className="max-h-80 overflow-y-auto py-1">
            <button
              onClick={() => choose("live")}
              className={`${MENU_ITEM} py-2 text-[var(--alc-fg-1)]`}
            >
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--alc-success)]" />
              Live
              <span className="ml-auto w-3">
                {history.selected === "live" && (
                  <Check size={12} className="text-[var(--alc-accent)]" />
                )}
              </span>
            </button>
            {history.deployments.map((record) => {
              const initiator = initiatorOf(record);
              return (
                <button
                  key={record.version}
                  onClick={() => choose(record.version)}
                  className={`${MENU_ITEM} py-2`}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: outcomeColor(record) }}
                    title={record.outcome ?? "in progress"}
                  />
                  <span className="font-mono font-medium text-[var(--alc-fg-1)]">
                    v{record.version}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--alc-fg-3)]">
                    {record.meta.command}
                  </span>
                  <span className="ml-auto flex flex-col items-end">
                    <span className="text-[11px] text-[var(--alc-fg-3)]">
                      {formatRelative(record.startedAt, now)}
                    </span>
                    {initiator && (
                      <span className="max-w-32 truncate font-mono text-[10.5px] text-[var(--alc-fg-4)]">
                        {initiator}
                      </span>
                    )}
                  </span>
                  <span className="w-3">
                    {history.selected === record.version && (
                      <Check size={12} className="text-[var(--alc-accent)]" />
                    )}
                  </span>
                </button>
              );
            })}
            {history.loading && history.deployments.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-[var(--alc-fg-4)]">
                loading…
              </p>
            )}
            {!history.loading &&
              history.deployments.length === 0 &&
              history.error === undefined && (
                <p className="px-3 py-2 text-[11px] text-[var(--alc-fg-4)]">
                  no recorded deployments
                </p>
              )}
            {history.error !== undefined && (
              <p className="px-3 py-2 text-[11px] text-[var(--alc-danger)]">
                {history.error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const HISTORICAL_STYLE = chipStyle("var(--alc-info)");

/** "viewing vN (historical)" indicator with a one-click return to Live. */
export function HistoricalPill() {
  const history = useHistory();
  if (history.selected === "live") {
    return null;
  }
  return (
    <button
      onClick={() => void selectDeployment("live")}
      className={`${CHIP} flex items-center gap-1.5 transition-opacity duration-[var(--alc-dur-fast)] hover:opacity-80`}
      style={HISTORICAL_STYLE}
      title="Return to the live document"
    >
      viewing v{history.selected} (historical)
      <X size={11} />
    </button>
  );
}
