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
  badgeStyle,
  CHIP,
  chipStyle,
  CLOUD_COLORS,
  cloudOf,
  EYEBROW,
  NEUTRAL_COLOR,
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
  const color = ui?.color ?? CLOUD_COLORS[cloudOf(node.type)] ?? NEUTRAL_COLOR;
  const Details = ui?.Details;

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col overflow-y-auto border-l border-[var(--alc-hairline-2)] bg-[var(--alc-bg-elev-1)]">
      <div className="flex items-start gap-2.5 border-b border-[var(--alc-hairline)] p-4">
        <div className="mt-0.5">
          <ResourceIcon ui={ui} color={color} size={18} kind={node.kind} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-[var(--alc-fg-1)]">
            {node.logicalId}
          </h2>
          <p className="truncate font-mono text-[11px] text-[var(--alc-fg-3)]">
            {node.type}
          </p>
          {node.path.length > 0 && (
            <p className="truncate font-mono text-[11px] text-[var(--alc-fg-4)]">
              {node.path.join(" / ")}
            </p>
          )}
        </div>
        <button
          onClick={() => setSelectedFqn(undefined)}
          className="rounded-[var(--alc-radius-sm)] p-1 text-[var(--alc-fg-4)] transition-colors duration-[var(--alc-dur-fast)] hover:bg-[var(--alc-bg-sunk)] hover:text-[var(--alc-fg-1)]"
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {applyResult && (
          <div
            className="rounded-[var(--alc-radius)] border px-3 py-2 text-[12px]"
            style={badgeStyle(RESULT_COLORS[applyResult] ?? NEUTRAL_COLOR)}
          >
            Last deploy: {RESULT_LABELS[applyResult] ?? applyResult}
            {applyResult === "deleted" && " — removed from the stack"}
          </div>
        )}
        {planAction && !applyResult && (
          <div
            className="rounded-[var(--alc-radius)] border px-3 py-2 text-[12px]"
            style={badgeStyle(PLAN_COLORS[planAction] ?? NEUTRAL_COLOR)}
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
                  className="rounded-[var(--alc-radius)] border border-[var(--alc-hairline-2)] px-2.5 py-1.5"
                >
                  <div className="font-mono text-[12px] text-[var(--alc-fg-2)]">
                    {b.sid}
                  </div>
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
            ? "var(--alc-warn)"
            : span.outcome === "fail"
              ? "var(--alc-danger)"
              : "var(--alc-success)";
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
                <span className="text-[var(--alc-fg-1)]">{span.op}</span>
                {span.phase && (
                  <span className="text-[10.5px] text-[var(--alc-fg-4)]">
                    {span.phase}
                  </span>
                )}
                <span
                  className={`${CHIP} ml-auto font-mono text-[10.5px]`}
                  style={chipStyle(outcomeColor)}
                >
                  {running
                    ? "running…"
                    : formatDuration(span.endTs! - span.startTs)}
                </span>
              </div>
              {waitMs !== undefined && waitMs > 0 && (
                <div className="pl-3.5 font-mono text-[10.5px] text-[var(--alc-fg-4)]">
                  waited {formatDuration(waitMs)}
                </div>
              )}
              {span.error !== undefined && (
                <div className="whitespace-pre-wrap break-all pl-3.5 font-mono text-[10.5px] text-[var(--alc-danger)]">
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
      <div className="max-h-64 overflow-y-auto rounded-[var(--alc-radius)] bg-[var(--alc-bg-code)] p-2">
        {entries.slice(-200).map((entry, i) => (
          <div
            key={i}
            className="flex gap-2 py-0.5 font-mono text-[10.5px] leading-relaxed"
          >
            <span className="shrink-0 text-[var(--alc-code-comment)]">
              {formatTime(entry.ts)}
            </span>
            <span
              className="w-12 shrink-0 uppercase"
              style={{ color: logLevelColor(entry.level) }}
            >
              {entry.level}
            </span>
            <span className="whitespace-pre-wrap break-all text-[var(--alc-fg-invert)]">
              {entry.message}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className={`${EYEBROW} mb-1.5`}>{children}</h3>;
}

function Fact({ fact, valueColor }: { fact: UIFact; valueColor?: string }) {
  const value = String(fact.value ?? "");
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="shrink-0 font-mono text-[11px] text-[var(--alc-fg-4)]">
        {fact.label}
      </span>
      {fact.href ? (
        <a
          href={fact.href}
          target="_blank"
          rel="noreferrer"
          className="truncate text-[var(--alc-accent-deep)] hover:underline"
        >
          {value}
        </a>
      ) : (
        <span
          className={`truncate text-[var(--alc-fg-1)] ${fact.mono ? "font-mono text-[11px]" : ""}`}
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
      className="flex items-center gap-1.5 truncate text-[12px] text-[var(--alc-accent-deep)] hover:underline"
    >
      <ExternalLink size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  );
}

function JsonBlock({ value, open }: { value: unknown; open?: boolean }) {
  return (
    <details open={open} className="group">
      <summary className="cursor-pointer font-mono text-[11px] text-[var(--alc-fg-4)] transition-colors duration-[var(--alc-dur-fast)] hover:text-[var(--alc-fg-2)]">
        json
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-[var(--alc-radius)] bg-[var(--alc-bg-code)] p-2 font-mono text-[10.5px] leading-relaxed text-[var(--alc-fg-invert)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

/**
 * Timeline log levels on the walnut code surface — the syntax palette is
 * tuned for that dark background in BOTH themes, so levels stay legible
 * where the page-level semantic tokens would sink into the walnut.
 */
const logLevelColor = (level: string): string => {
  switch (level.toLowerCase()) {
    case "error":
    case "fatal":
      return "var(--alc-code-literal)";
    case "warning":
      return "var(--alc-code-string)";
    case "debug":
    case "trace":
      return "var(--alc-code-comment)";
    case "status":
      return "var(--alc-code-keyword)";
    case "note":
      return "var(--alc-code-type)";
    default:
      return "var(--alc-code-comment)";
  }
};
