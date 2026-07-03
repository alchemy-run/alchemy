import { FlaskConical, Maximize, Search, X } from "lucide-react";
import { memo } from "react";
import { setStage } from "../ingest.ts";
import {
  requestFit,
  setFilter,
  setView,
  useConnection,
  useFilter,
  useFilterCounts,
  useMeta,
  useProjection,
  useView,
  type ViewKind,
} from "../store.ts";
import { PLAN_COLORS, PLAN_LABELS } from "../theme.ts";
import { DeploymentPicker, HistoricalPill } from "./DeploymentPicker.tsx";
import { StageSelect } from "./StageSelect.tsx";

const VIEWS: readonly ViewKind[] = [
  "canvas",
  "summary",
  "list",
  "table",
  "waterfall",
  "annotations",
];

/**
 * The shell header. TopBar itself subscribes to NOTHING — each child
 * subscribes to its own store slice, so a live deploy re-renders only the
 * plan chips, and typing in the filter re-renders only the filter box.
 */
export const TopBar = memo(function TopBar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#26262f] bg-[#101016] px-4">
      <FlaskConical size={16} className="text-indigo-400" />
      <StackName />
      <StageArea />
      <ConnectionDot />
      <PlanChips />
      <FilterBox />
      <div className="ml-auto flex items-center gap-2">
        <HistoricalPill />
        <DeploymentPicker />
        <FitButton />
        <ViewTabs />
      </div>
    </header>
  );
});

function StackName() {
  const meta = useMeta();
  return (
    <span className="text-[13px] font-medium text-zinc-100">{meta.stack}</span>
  );
}

function StageArea() {
  const meta = useMeta();
  return (
    <StageSelect
      stage={meta.stage}
      stages={meta.stages ?? []}
      onSelect={(stage) => setStage(stage)}
    />
  );
}

function ConnectionDot() {
  const connection = useConnection();
  if (connection.status === "live") {
    return null;
  }
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
        connection.status === "connecting"
          ? "animate-pulse bg-amber-500/15 text-amber-400"
          : "bg-red-500/15 text-red-400"
      }`}
      title={
        connection.status === "connecting"
          ? "Connecting to the dashboard server…"
          : "Connection lost — reconnecting"
      }
    >
      {connection.status === "connecting" ? "connecting…" : "reconnecting…"}
    </span>
  );
}

/** Pending-plan action counts (from the summary projection). */
function PlanChips() {
  const summary = useProjection("summary");
  const entries = Object.entries(summary.counts.byPlanAction).filter(
    ([, count]) => count > 0,
  );
  if (entries.length === 0) {
    return (
      <span className="rounded-full border border-[#2a2a35] px-2.5 py-0.5 text-[11px] text-emerald-400">
        ✓ in sync
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      {entries.map(([action, count]) => (
        <span
          key={action}
          className="rounded-full px-2.5 py-0.5 text-[11px] font-medium"
          style={{
            color: PLAN_COLORS[action],
            background: `${PLAN_COLORS[action]}1f`,
          }}
          title={`next deploy will ${action} ${count} resource${count > 1 ? "s" : ""}`}
        >
          {count} {PLAN_LABELS[action]?.slice(2) ?? action}
        </span>
      ))}
    </span>
  );
}

/**
 * Filter box + match-count chip. Filtering is decoration-only (dims
 * non-matching nodes) — it NEVER touches layout, positions, or viewport.
 */
function FilterBox() {
  const filter = useFilter();
  const counts = useFilterCounts();
  const active = filter.trim() !== "";
  return (
    <>
      <div className="relative ml-4 max-w-xs flex-1">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600"
        />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter resources…"
          className={`w-full rounded-lg border bg-[#0b0b10] py-1.5 pl-8 pr-8 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none ${
            active
              ? "border-amber-500/60 focus:border-amber-400"
              : "border-[#2a2a35] focus:border-indigo-500/50"
          }`}
        />
        {active && (
          <button
            onClick={() => setFilter("")}
            title="Clear filter"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {active && (
        <button
          onClick={() => setFilter("")}
          className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-400 hover:bg-amber-500/25"
          title="Click to clear the filter"
        >
          filtered: {counts.shown} of {counts.total} shown ✕
        </button>
      )}
    </>
  );
}

/** Explicit re-fit — the ONLY way to move the viewport besides the user. */
function FitButton() {
  const view = useView();
  if (view !== "canvas") {
    return null;
  }
  return (
    <button
      onClick={requestFit}
      title="Fit the graph to the viewport"
      className="rounded-lg border border-[#2a2a35] p-1.5 text-zinc-500 hover:border-[#3a3a48] hover:text-zinc-200"
    >
      <Maximize size={13} />
    </button>
  );
}

function ViewTabs() {
  const view = useView();
  return (
    <div className="flex rounded-lg border border-[#2a2a35] p-0.5">
      {VIEWS.map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={`rounded-md px-2.5 py-1 text-[12px] capitalize transition-colors ${
            view === v
              ? "bg-[#26262f] text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
