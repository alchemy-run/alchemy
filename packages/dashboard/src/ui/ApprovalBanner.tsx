import { ShieldQuestion } from "lucide-react";
import { memo } from "react";
import { decideApproval } from "../ingest.ts";
import { useApproval, useProjection } from "../store.ts";
import {
  CHIP,
  chipStyle,
  NEUTRAL_COLOR,
  PLAN_COLORS,
  PLAN_LABELS,
} from "../theme.ts";

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
    <div className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-3 rounded-[var(--alc-radius-lg)] border border-[var(--alc-hairline-2)] bg-[color-mix(in_srgb,var(--alc-accent)_10%,var(--alc-bg-elev-2))] px-4 py-2.5 shadow-[var(--alc-shadow-lg)] backdrop-blur">
      <ShieldQuestion
        size={16}
        className="shrink-0 text-[var(--alc-accent-deep)]"
      />
      <div className="text-[12.5px] text-[var(--alc-fg-2)]">
        <span className="font-serif text-[13.5px] font-medium tracking-[-0.01em] text-[var(--alc-fg-1)]">
          Deployment awaiting approval
        </span>
        <span className="ml-2 inline-flex gap-1.5">
          {entries.length === 0 ? (
            <span className="text-[var(--alc-fg-3)]">no resource changes</span>
          ) : (
            entries.map(([action, count]) => (
              <span
                key={action}
                className={CHIP}
                style={chipStyle(PLAN_COLORS[action] ?? NEUTRAL_COLOR)}
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
          className="rounded-[var(--alc-radius)] border border-[var(--alc-hairline-2)] px-3 py-1 text-[12px] text-[var(--alc-fg-3)] transition-colors duration-[var(--alc-dur)] hover:border-[var(--alc-danger)] hover:text-[var(--alc-danger)]"
        >
          Reject
        </button>
        <button
          onClick={() => void decideApproval(true)}
          className="rounded-[var(--alc-radius)] bg-[var(--alc-accent)] px-3 py-1 text-[12px] font-medium text-[var(--alc-fg-on-accent)] transition-colors duration-[var(--alc-dur)] hover:bg-[var(--alc-accent-deep)]"
        >
          Approve &amp; deploy
        </button>
      </div>
    </div>
  );
}
