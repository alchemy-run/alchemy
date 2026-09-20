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
  CHIP,
  chipStyle,
  EYEBROW,
  NEUTRAL_COLOR,
  PLAN_COLORS,
  PLAN_LABELS,
  RESULT_COLORS,
  RESULT_LABELS,
  SERIF_HEADING,
  wash,
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
        <p className="font-serif text-[15px] text-[var(--alc-fg-3)]">
          No deployment recorded yet
        </p>
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
          <pre className="max-h-72 overflow-auto rounded-[var(--alc-radius-lg)] border border-[var(--alc-hairline)] bg-[var(--alc-bg-code)] p-3 font-mono text-[11px] leading-relaxed text-[var(--alc-fg-invert)]">
            {JSON.stringify(summary.outputs, null, 2)}
          </pre>
        </section>
      )}

      {summary.annotations.length > 0 && (
        <section>
          <SectionTitle>Annotations</SectionTitle>
          <div className="space-y-2">
            {summary.annotations.map((annotation) => {
              const color =
                ANNOTATION_COLORS[annotation.style] ?? "var(--alc-info)";
              return (
                <div
                  key={annotation.context}
                  className="rounded-[var(--alc-radius)] border-l-[3px] p-3"
                  style={{
                    borderLeftColor: color,
                    background: wash(color, 10),
                  }}
                >
                  <Markdownish text={annotation.markdown} />
                </div>
              );
            })}
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
                className="rounded-[var(--alc-radius-lg)] border border-[var(--alc-hairline-2)] p-3"
                style={{ background: wash("var(--alc-danger)", 8) }}
              >
                <button
                  onClick={() => setSelectedFqn(failure.fqn)}
                  className="font-mono text-[12px] text-[var(--alc-danger)] hover:underline"
                >
                  {failure.fqn}
                </button>
                {failure.error !== undefined && (
                  <pre className="mt-2 whitespace-pre-wrap break-all rounded-[var(--alc-radius)] bg-[var(--alc-bg-code)] p-2 font-mono text-[11px] leading-relaxed text-[var(--alc-fg-invert)]">
                    {failure.error}
                  </pre>
                )}
                {failure.timelineTail.length > 0 && (
                  <div className="mt-2 rounded-[var(--alc-radius)] bg-[var(--alc-bg-code)] p-2">
                    {failure.timelineTail.map((entry, i) => (
                      <div
                        key={i}
                        className="flex gap-2 py-0.5 font-mono text-[10.5px] leading-relaxed"
                      >
                        <span className="shrink-0 text-[var(--alc-code-comment)]">
                          {formatTime(entry.ts)}
                        </span>
                        <span className="w-12 shrink-0 uppercase text-[var(--alc-code-comment)]">
                          {entry.level}
                        </span>
                        <span className="whitespace-pre-wrap break-all text-[var(--alc-fg-invert)]">
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

/** Annotation style → semantic token (website callout hues). */
export const ANNOTATION_COLORS: Record<string, string> = {
  success: "var(--alc-success)",
  info: "var(--alc-info)",
  warning: "var(--alc-warn)",
  error: "var(--alc-danger)",
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
    ? "var(--alc-warn)"
    : deployment.outcome === "succeeded"
      ? "var(--alc-success)"
      : deployment.outcome === "failed"
        ? "var(--alc-danger)"
        : "var(--alc-warn)";
  const initiator = deployment.initiator;
  return (
    <section className="rounded-[var(--alc-radius-lg)] border border-[var(--alc-hairline-2)] bg-[var(--alc-bg-elev-1)] p-4 shadow-[var(--alc-shadow-sm)]">
      <div className="flex items-center gap-3">
        <h1 className={`${SERIF_HEADING} text-[19px]`}>
          Deployment v{deployment.version}
        </h1>
        <span className="rounded-[var(--alc-radius-sm)] border border-[var(--alc-hairline-2)] px-2 py-px font-mono text-[11px] text-[var(--alc-fg-3)]">
          {deployment.command}
        </span>
        <span
          className={`${CHIP} ml-auto ${deployment.live ? "animate-pulse" : ""}`}
          style={chipStyle(outcomeColor)}
        >
          {outcome}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[11.5px] sm:grid-cols-3">
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
      <span className="shrink-0 text-[var(--alc-fg-4)]">{label}</span>
      <span className="truncate text-[var(--alc-fg-3)]" title={value}>
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
            className={`${CHIP} px-2.5 py-1 text-[12px]`}
            style={chipStyle(colors[action] ?? NEUTRAL_COLOR)}
          >
            {count} {labels[action]?.slice(2) ?? action}
          </span>
        ))}
      </div>
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className={`${EYEBROW} mb-2`}>{children}</h2>;
}
