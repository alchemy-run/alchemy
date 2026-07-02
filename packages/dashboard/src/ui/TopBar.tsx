import { FlaskConical, Search, X } from "lucide-react";
import { planSummary } from "../plan.ts";
import { PLAN_COLORS, PLAN_LABELS } from "../theme.ts";
import type { DashboardMeta, DashboardPlan } from "../types.ts";
import { StageSelect } from "./StageSelect.tsx";

export type View = "canvas" | "list";

export function TopBar({
  meta,
  stage,
  onStage,
  plan,
  view,
  onView,
  query,
  onQuery,
  shown,
  total,
}: {
  meta: DashboardMeta;
  stage: string;
  onStage: (stage: string) => void;
  plan?: DashboardPlan;
  view: View;
  onView: (view: View) => void;
  query: string;
  onQuery: (query: string) => void;
  /** nodes visible after filtering / total nodes */
  shown: number;
  total: number;
}) {
  const summary = planSummary(plan);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#26262f] bg-[#101016] px-4">
      <FlaskConical size={16} className="text-indigo-400" />
      <span className="text-[13px] font-medium text-zinc-100">
        {meta.stack}
      </span>
      <StageSelect stage={stage} stages={meta.stages} onSelect={onStage} />
      {plan === undefined && (
        <span className="text-[11px] text-zinc-600">planning…</span>
      )}
      {plan?.available &&
        (summary.length === 0 ? (
          <span className="rounded-full border border-[#2a2a35] px-2.5 py-0.5 text-[11px] text-emerald-400">
            ✓ in sync
          </span>
        ) : (
          summary.map(({ action, count }) => (
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
          ))
        ))}

      <div className="relative ml-4 flex-1 max-w-xs">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600"
        />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Filter resources…"
          className={`w-full rounded-lg border bg-[#0b0b10] py-1.5 pl-8 pr-8 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none ${
            query.trim()
              ? "border-amber-500/60 focus:border-amber-400"
              : "border-[#2a2a35] focus:border-indigo-500/50"
          }`}
        />
        {query.trim() && (
          <button
            onClick={() => onQuery("")}
            title="Clear filter"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {query.trim() && (
        <button
          onClick={() => onQuery("")}
          className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-400 hover:bg-amber-500/25"
          title="Click to clear the filter"
        >
          filtered: {shown} of {total} shown ✕
        </button>
      )}

      <div className="ml-auto flex rounded-lg border border-[#2a2a35] p-0.5">
        {(["canvas", "list"] as const).map((v) => (
          <button
            key={v}
            onClick={() => onView(v)}
            className={`rounded-md px-3 py-1 text-[12px] capitalize transition-colors ${
              view === v
                ? "bg-[#26262f] text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {v}
          </button>
        ))}
      </div>
    </header>
  );
}
