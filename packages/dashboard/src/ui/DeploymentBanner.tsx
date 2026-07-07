import { Check, Loader2, ShieldQuestion, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { decideApproval } from "../ingest.ts";
import { useApproval, useDeployment, useProjection } from "../store.ts";
import {
  CHIP,
  chipStyle,
  NEUTRAL_COLOR,
  PLAN_COLORS,
  PLAN_LABELS,
} from "../theme.ts";

/**
 * The floating banner follows the whole deployment lifecycle in one shell,
 * so the approve button literally transforms into the run's status:
 *
 *   reviewing  — plan chips + Reject / Approve & deploy
 *   starting   — approve clicked; spinner while the deploy spins up
 *   deploying  — live run; spinner + applied/planned progress
 *   settled    — ✓ / ✗ flash for a few seconds, then the banner retires
 *
 * The settled flash only fires on a live→ended transition observed by THIS
 * tab — a freshly opened tab on an idle stage never shows a stale verdict.
 */
export const DeploymentBanner = memo(function DeploymentBanner() {
  const approval = useApproval();
  const deployment = useDeployment();

  // approve/reject latch — lives here (not in the reviewing sub-view) so
  // the "starting" phase survives the approval overlay being replaced by
  // the live deployment record.
  const [deciding, setDeciding] = useState<"approve" | "reject" | undefined>();
  useEffect(() => {
    if (deciding === "approve" && deployment?.live === true) {
      setDeciding(undefined); // the run took over — spinner now tracks it
    }
    if (deciding === "reject" && approval === undefined) {
      setDeciding(undefined);
    }
  }, [deciding, deployment?.live, approval]);

  // settled flash: only on a live→ended transition seen in this session
  const prevLive = useRef(false);
  const [settled, setSettled] = useState<
    { outcome: string; command: string } | undefined
  >();
  useEffect(() => {
    const wasLive = prevLive.current;
    prevLive.current = deployment?.live === true;
    if (wasLive && deployment !== undefined && deployment.live === false) {
      setSettled({
        outcome: deployment.outcome ?? "succeeded",
        command: deployment.meta.command,
      });
      const timer = setTimeout(() => setSettled(undefined), 6000);
      return () => clearTimeout(timer);
    }
  }, [deployment]);

  if (deployment?.live === true) {
    return (
      <Shell>
        <Deploying command={deployment.meta.command} />
      </Shell>
    );
  }
  if (approval !== undefined) {
    return (
      <Shell>
        <Reviewing deciding={deciding} setDeciding={setDeciding} />
      </Shell>
    );
  }
  if (deciding === "approve") {
    return (
      <Shell>
        <Loader2
          size={16}
          className="animate-spin text-[var(--alc-accent-deep)]"
        />
        <span className="font-serif text-[13.5px] font-medium tracking-[-0.01em] text-[var(--alc-fg-1)]">
          Starting deployment…
        </span>
      </Shell>
    );
  }
  if (settled !== undefined) {
    return (
      <Shell>
        <Settled outcome={settled.outcome} command={settled.command} />
      </Shell>
    );
  }
  return null;
});

/** Shared floating shell so every phase morphs in place. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-3 rounded-[var(--alc-radius-lg)] border border-[var(--alc-hairline-2)] bg-[color-mix(in_srgb,var(--alc-accent)_10%,var(--alc-bg-elev-2))] px-4 py-2.5 shadow-[var(--alc-shadow-lg)] backdrop-blur">
      {children}
    </div>
  );
}

function Reviewing({
  deciding,
  setDeciding,
}: {
  deciding: "approve" | "reject" | undefined;
  setDeciding: (d: "approve" | "reject") => void;
}) {
  const summary = useProjection("summary");
  const entries = Object.entries(summary.counts.byPlanAction).filter(
    ([, count]) => count > 0,
  );
  return (
    <>
      {deciding === "approve" ? (
        <Loader2
          size={16}
          className="shrink-0 animate-spin text-[var(--alc-accent-deep)]"
        />
      ) : (
        <ShieldQuestion
          size={16}
          className="shrink-0 text-[var(--alc-accent-deep)]"
        />
      )}
      <div className="text-[12.5px] text-[var(--alc-fg-2)]">
        <span className="font-serif text-[13.5px] font-medium tracking-[-0.01em] text-[var(--alc-fg-1)]">
          {deciding === "approve"
            ? "Starting deployment…"
            : "Deployment awaiting approval"}
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
      {deciding !== "approve" && (
        <div className="ml-2 flex gap-2">
          <button
            disabled={deciding !== undefined}
            onClick={() => {
              setDeciding("reject");
              void decideApproval(false);
            }}
            className="rounded-[var(--alc-radius)] border border-[var(--alc-hairline-2)] px-3 py-1 text-[12px] text-[var(--alc-fg-3)] transition-colors duration-[var(--alc-dur)] hover:border-[var(--alc-danger)] hover:text-[var(--alc-danger)] disabled:opacity-50"
          >
            {deciding === "reject" ? "Rejecting…" : "Reject"}
          </button>
          <button
            disabled={deciding !== undefined}
            onClick={() => {
              setDeciding("approve");
              void decideApproval(true);
            }}
            className="rounded-[var(--alc-radius)] bg-[var(--alc-accent)] px-3 py-1 text-[12px] font-medium text-[var(--alc-fg-on-accent)] transition-colors duration-[var(--alc-dur)] hover:bg-[var(--alc-accent-deep)] disabled:opacity-60"
          >
            Approve & deploy
          </button>
        </div>
      )}
    </>
  );
}

const COMMAND_LABELS: Record<string, [running: string, done: string]> = {
  deploy: ["Deploying", "Deployed"],
  destroy: ["Destroying", "Destroyed"],
};

function Deploying({ command }: { command: string }) {
  const summary = useProjection("summary");
  const planned = Object.values(summary.counts.byPlanAction).reduce(
    (a, b) => a + b,
    0,
  );
  const applied = Object.values(summary.counts.byApplyResult).reduce(
    (a, b) => a + b,
    0,
  );
  const failed = summary.counts.byApplyResult.failed ?? 0;
  return (
    <>
      <Loader2
        size={16}
        className="shrink-0 animate-spin text-[var(--alc-accent-deep)]"
      />
      <span className="font-serif text-[13.5px] font-medium tracking-[-0.01em] text-[var(--alc-fg-1)]">
        {COMMAND_LABELS[command]?.[0] ?? "Applying"}…
      </span>
      {planned > 0 && (
        <span className="font-mono text-[12px] text-[var(--alc-fg-3)]">
          {Math.min(applied, planned)} / {planned}
        </span>
      )}
      {failed > 0 && (
        <span className={CHIP} style={chipStyle("var(--alc-danger)")}>
          {failed} failed
        </span>
      )}
    </>
  );
}

function Settled({ outcome, command }: { outcome: string; command: string }) {
  const summary = useProjection("summary");
  const failed = summary.counts.byApplyResult.failed ?? 0;
  const ok = outcome === "succeeded" && failed === 0;
  const color = ok ? "var(--alc-success)" : "var(--alc-danger)";
  const label = ok
    ? (COMMAND_LABELS[command]?.[1] ?? "Done")
    : outcome === "interrupted"
      ? "Deployment interrupted"
      : "Deployment failed";
  return (
    <>
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={chipStyle(color)}
      >
        {ok ? <Check size={13} /> : <X size={13} />}
      </span>
      <span
        className="font-serif text-[13.5px] font-medium tracking-[-0.01em]"
        style={{ color }}
      >
        {label}
      </span>
      {failed > 0 && (
        <span className={CHIP} style={chipStyle("var(--alc-danger)")}>
          {failed} failed
        </span>
      )}
    </>
  );
}
