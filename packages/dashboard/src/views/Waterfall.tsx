import type { WaterfallRowView } from "alchemy/Dashboard/Projections";
import { memo } from "react";
import { formatDuration, useNow } from "../format.ts";
import { setSelectedFqn, useDeployment, useProjection } from "../store.ts";

/**
 * The Waterfall view: per-resource bars on a shared time axis built from
 * op spans — muted wait segments (pending → op-start) and run segments
 * colored by outcome. Pure CSS bars, no chart lib; hover shows exact
 * timings. Ticks only while the deployment is live and an op is open.
 */
export const WaterfallView = memo(function WaterfallView() {
  const rows = useProjection("waterfall");
  const deployment = useDeployment();

  const hasOpen = rows.some((row) =>
    row.segments.some((segment) => segment.endTs === undefined),
  );
  const live = (deployment?.live ?? false) && hasOpen;
  const now = useNow(1000, live);

  if (rows.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-zinc-600">
        No lifecycle operations recorded for this deployment
      </p>
    );
  }

  // shared time axis: anchor at the deployment start when we have it
  let t0 = deployment?.startedAt ?? Number.POSITIVE_INFINITY;
  let tEnd = 0;
  for (const row of rows) {
    for (const segment of row.segments) {
      t0 = Math.min(t0, segment.startTs);
      tEnd = Math.max(tEnd, segment.endTs ?? now);
    }
  }
  const total = Math.max(tEnd - t0, 1);

  const TICKS = 5;
  const ticks = Array.from(
    { length: TICKS + 1 },
    (_, i) => (total / TICKS) * i,
  );

  return (
    <div className="mx-auto max-w-5xl p-6">
      {/* axis */}
      <div className="mb-1 flex">
        <div className="w-56 shrink-0" />
        <div className="relative h-4 min-w-0 flex-1">
          {ticks.map((tick, i) => (
            <span
              key={i}
              className="absolute top-0 -translate-x-1/2 font-mono text-[10px] text-zinc-600"
              style={{ left: `${(tick / total) * 100}%` }}
            >
              +{formatDuration(tick)}
            </span>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-[#26262f]">
        {rows.map((row) => (
          <WaterfallRow
            key={row.fqn}
            row={row}
            t0={t0}
            total={total}
            now={now}
          />
        ))}
      </div>
    </div>
  );
});

const WaterfallRow = memo(function WaterfallRow({
  row,
  t0,
  total,
  now,
}: {
  row: WaterfallRowView;
  t0: number;
  total: number;
  now: number;
}) {
  const label = row.fqn.split("/").at(-1) ?? row.fqn;
  return (
    <div className="flex items-center border-t border-[#1c1c24] first:border-t-0 hover:bg-[#101016]">
      <button
        onClick={() => setSelectedFqn(row.fqn)}
        className="w-56 shrink-0 truncate px-4 py-2 text-left font-mono text-[11.5px] text-zinc-300 hover:text-zinc-100"
        title={row.fqn}
      >
        {label}
      </button>
      <div className="relative h-8 min-w-0 flex-1">
        {/* faint grid lines at the axis ticks */}
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="absolute bottom-0 top-0 w-px bg-[#1c1c24]"
            style={{ left: `${(i / 5) * 100}%` }}
          />
        ))}
        {row.segments.map((segment, i) => {
          const end = segment.endTs ?? now;
          const running = segment.endTs === undefined;
          const left = ((segment.startTs - t0) / total) * 100;
          const width = Math.max(((end - segment.startTs) / total) * 100, 0.4);
          const color =
            segment.kind === "wait"
              ? "#3f3f4a"
              : running
                ? "#fbbf24"
                : segment.outcome === "fail"
                  ? "#f87171"
                  : "#34d399";
          const title =
            segment.kind === "wait"
              ? `waited ${formatDuration(end - segment.startTs)} (+${formatDuration(segment.startTs - t0)})`
              : `${segment.op ?? "op"} · ${running ? "running" : formatDuration(end - segment.startTs)} (+${formatDuration(segment.startTs - t0)})${segment.outcome ? ` · ${segment.outcome}` : ""}`;
          return (
            <span
              key={i}
              className={`absolute top-1/2 h-3 -translate-y-1/2 rounded-sm ${running ? "animate-pulse" : ""}`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: color,
                opacity: segment.kind === "wait" ? 0.6 : 0.9,
              }}
              title={title}
            />
          );
        })}
      </div>
    </div>
  );
});
