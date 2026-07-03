import { ShieldQuestion } from "lucide-react";
import { memo } from "react";
import { decideApproval } from "../ingest.ts";
import { useApproval, useProjection } from "../store.ts";
import { PLAN_COLORS, PLAN_LABELS } from "../theme.ts";

/**
 * Shown when a `deploy --ui` run (without `--yes`) is waiting for the plan
 * to be approved from the browser. The canvas below renders the pending
 * plan's badges; this banner carries the decision. Approval is always a
 * LIVE-document concern (never overlaid by history).
 */
export const ApprovalBanner = memo(function ApprovalBanner() {
  const approval = useApproval();
  if (approval === undefined) {
    return null;
  }
  return <Banner />;
});

function Banner() {
  const summary = useProjection("summary");
  const entries = Object.entries(summary.counts.byPlanAction).filter(
    ([, count]) => count > 0,
  );
  return (
    <div className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-indigo-500/40 bg-[#12121c]/95 px-4 py-2.5 shadow-xl shadow-black/40 backdrop-blur">
      <ShieldQuestion size={16} className="shrink-0 text-indigo-400" />
      <div className="text-[12.5px] text-zinc-200">
        Deployment awaiting approval
        <span className="ml-2 inline-flex gap-1.5">
          {entries.length === 0 ? (
            <span className="text-zinc-500">no resource changes</span>
          ) : (
            entries.map(([action, count]) => (
              <span
                key={action}
                className="rounded-full px-2 py-px text-[11px] font-medium"
                style={{
                  color: PLAN_COLORS[action],
                  background: `${PLAN_COLORS[action]}1f`,
                }}
              >
                {count} {PLAN_LABELS[action]?.slice(2) ?? action}
              </span>
            ))
          )}
        </span>
      </div>
      <div className="ml-2 flex gap-2">
        <button
          onClick={() => void decideApproval(false)}
          className="rounded-lg border border-[#2a2a35] px-3 py-1 text-[12px] text-zinc-400 hover:border-red-500/50 hover:text-red-400"
        >
          Reject
        </button>
        <button
          onClick={() => void decideApproval(true)}
          className="rounded-lg bg-emerald-500 px-3 py-1 text-[12px] font-medium text-[#0b0b10] hover:bg-emerald-400"
        >
          Approve &amp; deploy
        </button>
      </div>
    </div>
  );
}
