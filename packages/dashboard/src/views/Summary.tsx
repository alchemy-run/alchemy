import type { SummaryDeploymentView } from "alchemy/Dashboard/Projections";
import { memo } from "react";
import {
  formatDateTime,
  formatDuration,
  formatTime,
  useNow,
} from "../format.ts";
import { setSelectedFqn, useProjection } from "../store.ts";
import {
  PLAN_COLORS,
  PLAN_LABELS,
  RESULT_COLORS,
  RESULT_LABELS,
} from "../theme.ts";
import { Markdownish } from "../ui/Markdownish.tsx";

/**
 * The Summary view: deployment header, action counts, stack outputs,
 * annotations, and a failure rollup with timeline tails — a pure render of
 * the `summaryOf` projection (live or the selected historical version).
 */
export const SummaryView = memo(function SummaryView() {
  const summary = useProjection("summary");
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {summary.deployment !== undefined ? (
        <DeploymentHeader deployment={summary.deployment} />
      ) : (
        <p className="text-sm text-zinc-600">No deployment recorded yet</p>
      )}

      <Counts
        title="Planned"
        counts={summary.counts.byPlanAction}
        colors={PLAN_COLORS}
        labels={PLAN_LABELS}
      />
      <Counts
        title="Applied"
        counts={summary.counts.byApplyResult}
        colors={RESULT_COLORS}
        labels={RESULT_LABELS}
      />

      {summary.outputs !== undefined && (
        <section>
          <SectionTitle>Outputs</SectionTitle>
          <pre className="max-h-72 overflow-auto rounded-xl border border-[#26262f] bg-[#0b0b10] p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
            {JSON.stringify(summary.outputs, null, 2)}
          </pre>
        </section>
      )}

      {summary.annotations.length > 0 && (
        <section>
          <SectionTitle>Annotations</SectionTitle>
          <div className="space-y-2">
            {summary.annotations.map((annotation) => (
              <div
                key={annotation.context}
                className="rounded-xl border p-3"
                style={{
                  borderColor: `${ANNOTATION_COLORS[annotation.style]}44`,
                  background: `${ANNOTATION_COLORS[annotation.style]}0d`,
                }}
              >
                <Markdownish text={annotation.markdown} />
              </div>
            ))}
          </div>
        </section>
      )}

      {summary.failures.length > 0 && (
        <section>
          <SectionTitle>Failures</SectionTitle>
          <div className="space-y-3">
            {summary.failures.map((failure) => (
              <div
                key={failure.fqn}
                className="rounded-xl border border-red-500/30 bg-red-500/5 p-3"
              >
                <button
                  onClick={() => setSelectedFqn(failure.fqn)}
                  className="font-mono text-[12px] text-red-300 hover:underline"
                >
                  {failure.fqn}
                </button>
                {failure.error !== undefined && (
                  <p className="mt-1 whitespace-pre-wrap break-all text-[11.5px] text-red-400/90">
                    {failure.error}
                  </p>
                )}
                {failure.timelineTail.length > 0 && (
                  <div className="mt-2 rounded-lg bg-[#0b0b10] p-2">
                    {failure.timelineTail.map((entry, i) => (
                      <div
                        key={i}
                        className="flex gap-2 py-0.5 font-mono text-[10.5px] leading-relaxed"
                      >
                        <span className="shrink-0 text-zinc-600">
                          {formatTime(entry.ts)}
                        </span>
                        <span className="w-12 shrink-0 uppercase text-zinc-500">
                          {entry.level}
                        </span>
                        <span className="whitespace-pre-wrap break-all text-zinc-400">
                          {entry.message}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
});

export const ANNOTATION_COLORS: Record<string, string> = {
  success: "#34d399",
  info: "#818cf8",
  warning: "#fbbf24",
  error: "#f87171",
};

function DeploymentHeader({
  deployment,
}: {
  deployment: SummaryDeploymentView;
}) {
  // tick every second ONLY while the deployment is live
  const now = useNow(1000, deployment.live);
  const durationMs =
    deployment.durationMs ??
    (deployment.live ? now - deployment.startedAt : undefined);
  const outcome = deployment.live ? "running" : (deployment.outcome ?? "—");
  const outcomeColor = deployment.live
    ? "#fbbf24"
    : deployment.outcome === "succeeded"
      ? "#34d399"
      : deployment.outcome === "failed"
        ? "#f87171"
        : "#fbbf24";
  const initiator = deployment.initiator;
  return (
    <section className="rounded-xl border border-[#26262f] bg-[#101016] p-4">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-medium text-zinc-100">
          Deployment v{deployment.version}
        </h1>
        <span className="rounded-full border border-[#2a2a35] px-2 py-px text-[11px] text-zinc-400">
          {deployment.command}
        </span>
        <span
          className={`ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-medium ${deployment.live ? "animate-pulse" : ""}`}
          style={{ color: outcomeColor, background: `${outcomeColor}1f` }}
        >
          {outcome}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-3">
        <HeaderFact
          label="started"
          value={formatDateTime(deployment.startedAt)}
        />
        <HeaderFact
          label="duration"
          value={durationMs !== undefined ? formatDuration(durationMs) : "—"}
        />
        {initiator !== undefined && (
          <HeaderFact
            label="initiator"
            value={
              initiator.user !== undefined && initiator.host !== undefined
                ? `${initiator.user}@${initiator.host}`
                : (initiator.user ?? initiator.host ?? "—")
            }
          />
        )}
      </div>
    </section>
  );
}

function HeaderFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className="truncate text-zinc-200" title={value}>
        {value}
      </span>
    </div>
  );
}

function Counts({
  title,
  counts,
  colors,
  labels,
}: {
  title: string;
  counts: Record<string, number>;
  colors: Record<string, string>;
  labels: Record<string, string>;
}) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    return null;
  }
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <div className="flex flex-wrap gap-2">
        {entries.map(([action, count]) => (
          <span
            key={action}
            className="rounded-full px-3 py-1 text-[12px] font-medium"
            style={{
              color: colors[action] ?? "#8b8b96",
              background: `${colors[action] ?? "#8b8b96"}1f`,
            }}
          >
            {count} {labels[action]?.slice(2) ?? action}
          </span>
        ))}
      </div>
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
      {children}
    </h2>
  );
}
