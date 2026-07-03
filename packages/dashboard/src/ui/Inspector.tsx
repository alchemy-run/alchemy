import type { Decoration, DocumentNode } from "alchemy/Dashboard/Document";
import type { UIFact } from "alchemy/UI/UIProvider";
import { ExternalLink, X } from "lucide-react";
import { memo, useMemo } from "react";
import { formatDuration, formatTime } from "../format.ts";
import {
  setSelectedFqn,
  useMeta,
  useNode,
  useOpSpans,
  useSelectedFqn,
  useTimeline,
} from "../store.ts";
import {
  CLOUD_COLORS,
  cloudOf,
  PLAN_COLORS,
  PLAN_LABELS,
  RESULT_COLORS,
  RESULT_LABELS,
  statusColor,
} from "../theme.ts";
import { safeUI, uiCtxOf, useRegistry } from "../uiRegistry.ts";
import { ResourceIcon } from "./Icon.tsx";

/**
 * Right-hand detail panel for the selected resource. Subscribes only to
 * the selected fqn's slices (node/decoration, timeline, op spans) — live
 * events for OTHER resources never re-render it. When a structure-replace
 * retires the selected fqn the store clears the selection (no silent
 * unmount mid-render).
 */
export const Inspector = memo(function Inspector() {
  const fqn = useSelectedFqn();
  if (fqn === undefined) {
    return null;
  }
  return <InspectorPanel key={fqn} fqn={fqn} />;
});

function InspectorPanel({ fqn }: { fqn: string }) {
  const { node, decoration } = useNode(fqn);
  if (node === undefined) {
    // transient: the store clears selection when the fqn leaves structure
    return null;
  }
  return <InspectorBody node={node} decoration={decoration} />;
}

function InspectorBody({
  node,
  decoration,
}: {
  node: DocumentNode;
  decoration: Decoration | undefined;
}) {
  const meta = useMeta();
  const registry = useRegistry();

  const status = decoration?.status ?? node.status;
  const applyResult = decoration?.applyResult;
  const planAction = node.planAction ?? decoration?.planAction;
  const note = decoration?.note;

  const ui = registry?.get(node.type);
  const ctx = useMemo(() => uiCtxOf(node, status, meta), [node, status, meta]);
  const facts = useMemo(() => safeUI(() => ui?.facts?.(ctx)) ?? [], [ui, ctx]);
  const link = useMemo(() => safeUI(() => ui?.link?.(ctx)), [ui, ctx]);
  const consoleUrl = useMemo(
    () => safeUI(() => ui?.consoleUrl?.(ctx)),
    [ui, ctx],
  );
  const color = ui?.color ?? CLOUD_COLORS[cloudOf(node.type)] ?? "#8b8b96";
  const Details = ui?.Details;

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col overflow-y-auto border-l border-[#26262f] bg-[#101016]">
      <div className="flex items-start gap-2.5 border-b border-[#26262f] p-4">
        <div className="mt-0.5">
          <ResourceIcon ui={ui} color={color} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-zinc-100">
            {node.logicalId}
          </h2>
          <p className="truncate text-[11px] text-zinc-500">{node.type}</p>
          {node.path.length > 0 && (
            <p className="truncate text-[11px] text-zinc-600">
              {node.path.join(" / ")}
            </p>
          )}
        </div>
        <button
          onClick={() => setSelectedFqn(undefined)}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {applyResult && (
          <div
            className="rounded-lg border px-3 py-2 text-[12px]"
            style={{
              borderColor: `${RESULT_COLORS[applyResult]}55`,
              background: `${RESULT_COLORS[applyResult]}14`,
              color: RESULT_COLORS[applyResult],
            }}
          >
            Last deploy: {RESULT_LABELS[applyResult] ?? applyResult}
            {applyResult === "deleted" && " — removed from the stack"}
          </div>
        )}
        {planAction && !applyResult && (
          <div
            className="rounded-lg border px-3 py-2 text-[12px]"
            style={{
              borderColor: `${PLAN_COLORS[planAction]}55`,
              background: `${PLAN_COLORS[planAction]}14`,
              color: PLAN_COLORS[planAction],
            }}
          >
            Next deploy: {PLAN_LABELS[planAction] ?? planAction}
            {status === "pending" &&
              " — not deployed yet, defined in the stack file"}
            {planAction === "delete" &&
              status !== "pending" &&
              " — no longer in the stack file (orphaned)"}
          </div>
        )}
        <section className="space-y-1.5">
          <Fact
            fact={{ label: "status", value: status }}
            valueColor={statusColor(status)}
          />
          <Fact fact={{ label: "fqn", value: node.fqn, mono: true }} />
          {note !== undefined && <Fact fact={{ label: "note", value: note }} />}
          {facts
            .filter((f) => f.value !== undefined)
            .map((f, i) => (
              <Fact key={i} fact={f} />
            ))}
        </section>

        {(link || consoleUrl) && (
          <section className="space-y-1.5">
            {link && <LinkRow href={link} label={link} />}
            {consoleUrl && (
              <LinkRow
                href={consoleUrl}
                label={`Open in ${cloudOf(node.type)} console`}
              />
            )}
          </section>
        )}

        {Details && (
          <section>
            <Details ctx={ctx} />
          </section>
        )}

        <Operations fqn={node.fqn} />
        <Timeline fqn={node.fqn} />

        {node.bindings.length > 0 && (
          <section>
            <SectionTitle>Bindings</SectionTitle>
            <div className="space-y-1.5">
              {node.bindings.map((b, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-[#26262f] px-2.5 py-1.5"
                >
                  <div className="text-[12px] text-zinc-300">{b.sid}</div>
                  <JsonBlock value={b.data} />
                </div>
              ))}
            </div>
          </section>
        )}

        {node.attrs && Object.keys(node.attrs).length > 0 && (
          <section>
            <SectionTitle>Attributes</SectionTitle>
            <JsonBlock value={node.attrs} open />
          </section>
        )}

        {node.props && Object.keys(node.props).length > 0 && (
          <section>
            <SectionTitle>Properties</SectionTitle>
            <JsonBlock value={node.props} />
          </section>
        )}
      </div>
    </aside>
  );
}

/** Lifecycle op spans: what ran, for how long, and how it ended. */
function Operations({ fqn }: { fqn: string }) {
  const { spans } = useOpSpans(fqn);
  if (spans.length === 0) {
    return null;
  }
  return (
    <section>
      <SectionTitle>Operations</SectionTitle>
      <div className="space-y-1">
        {spans.map((span) => {
          const running = span.endTs === undefined;
          const outcomeColor = running
            ? "#fbbf24"
            : span.outcome === "fail"
              ? "#f87171"
              : "#34d399";
          const waitMs =
            span.pendingTs !== undefined
              ? span.startTs - span.pendingTs
              : undefined;
          return (
            <div key={span.opId} className="text-[12px]">
              <div className="flex items-baseline gap-2">
                <span
                  className="h-1.5 w-1.5 shrink-0 self-center rounded-full"
                  style={{ background: outcomeColor }}
                />
                <span className="text-zinc-200">{span.op}</span>
                {span.phase && (
                  <span className="text-[10.5px] text-zinc-600">
                    {span.phase}
                  </span>
                )}
                <span className="ml-auto font-mono text-[11px] text-zinc-400">
                  {running
                    ? "running…"
                    : formatDuration(span.endTs! - span.startTs)}
                </span>
              </div>
              {waitMs !== undefined && waitMs > 0 && (
                <div className="pl-3.5 text-[10.5px] text-zinc-600">
                  waited {formatDuration(waitMs)}
                </div>
              )}
              {span.error !== undefined && (
                <div className="whitespace-pre-wrap break-all pl-3.5 text-[10.5px] text-red-400">
                  {span.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Per-resource deploy timeline (statuses, notes, captured logs). */
function Timeline({ fqn }: { fqn: string }) {
  const { entries } = useTimeline(fqn);
  if (entries.length === 0) {
    return null;
  }
  return (
    <section>
      <SectionTitle>Timeline</SectionTitle>
      <div className="max-h-64 overflow-y-auto rounded-lg bg-[#0b0b10] p-2">
        {entries.slice(-200).map((entry, i) => (
          <div
            key={i}
            className="flex gap-2 py-0.5 font-mono text-[10.5px] leading-relaxed"
          >
            <span className="shrink-0 text-zinc-600">
              {formatTime(entry.ts)}
            </span>
            <span
              className="w-12 shrink-0 uppercase"
              style={{ color: logLevelColor(entry.level) }}
            >
              {entry.level}
            </span>
            <span className="whitespace-pre-wrap break-all text-zinc-400">
              {entry.message}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
      {children}
    </h3>
  );
}

function Fact({ fact, valueColor }: { fact: UIFact; valueColor?: string }) {
  const value = String(fact.value ?? "");
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="shrink-0 text-zinc-500">{fact.label}</span>
      {fact.href ? (
        <a
          href={fact.href}
          target="_blank"
          rel="noreferrer"
          className="truncate text-indigo-400 hover:underline"
        >
          {value}
        </a>
      ) : (
        <span
          className={`truncate text-zinc-200 ${fact.mono ? "font-mono text-[11px]" : ""}`}
          style={valueColor ? { color: valueColor } : undefined}
          title={value}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function LinkRow({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 truncate text-[12px] text-indigo-400 hover:underline"
    >
      <ExternalLink size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  );
}

function JsonBlock({ value, open }: { value: unknown; open?: boolean }) {
  return (
    <details open={open} className="group">
      <summary className="cursor-pointer text-[11px] text-zinc-600 hover:text-zinc-400">
        json
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-[#0b0b10] p-2 text-[10.5px] leading-relaxed text-zinc-400">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

const logLevelColor = (level: string): string => {
  switch (level.toLowerCase()) {
    case "error":
    case "fatal":
      return "#f87171";
    case "warning":
      return "#fbbf24";
    case "debug":
    case "trace":
      return "#52525b";
    case "status":
      return "#34d399";
    case "note":
      return "#818cf8";
    default:
      return "#71717a";
  }
};
