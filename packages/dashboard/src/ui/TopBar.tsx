import { FlaskConical, Search } from "lucide-react";
import { planSummary } from "../plan.ts";
import { PLAN_COLORS, PLAN_LABELS } from "../theme.ts";
import type { DashboardMeta, DashboardPlan } from "../types.ts";

export type View = "canvas" | "list";

export function TopBar({
  meta,
  plan,
  view,
  onView,
  query,
  onQuery,
}: {
  meta: DashboardMeta;
  plan?: DashboardPlan;
  view: View;
  onView: (view: View) => void;
  query: string;
  onQuery: (query: string) => void;
}) {
  const summary = planSummary(plan);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#26262f] bg-[#101016] px-4">
      <FlaskConical size={16} className="text-indigo-400" />
      <span className="text-[13px] font-medium text-zinc-100">
        {meta.stack}
      </span>
      <span className="rounded-full border border-[#2a2a35] px-2.5 py-0.5 text-[11px] text-zinc-400">
        {meta.stage}
      </span>
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
          className="w-full rounded-lg border border-[#2a2a35] bg-[#0b0b10] py-1.5 pl-8 pr-3 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
        />
      </div>

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
