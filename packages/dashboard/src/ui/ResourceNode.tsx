/**
 * The canvas node card (alchemy brand skin, v2 data flow).
 *
 * React Flow hands this component `data: { fqn }` ONLY — everything else is
 * read from the store via per-fqn subscriptions, so:
 * - a decorate patch re-renders exactly the affected node(s);
 * - clicking re-renders 2 nodes (old + new selection);
 *
 * Theming: every color is a CSS var over the --alc-* tokens, so a
 * [data-theme] flip recolors nodes with ZERO re-renders. Inline style
 * objects that depend on a color go through the cached helpers
 * (`chipStyle`, `bgOf`, `fgOf`) — stable identity per color, never a
 * fresh object per color per render.
 *
 * History overlay: `useNode` is overlay-aware (structure is always live,
 * decoration comes from the selected deployment when one is open), so
 * flipping through past deployments recolors cards with zero layout change.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ResourceUIContext } from "alchemy/UI/UIProvider";
import { Check, Loader2, X } from "lucide-react";
import { memo, useMemo, type CSSProperties } from "react";
import { NODE_HEIGHT, NODE_WIDTH } from "../layout/elkGraph.ts";
import {
  chipStyle,
  CLOUD_COLORS,
  cloudOf,
  inFlightColor,
  NEUTRAL_COLOR,
  PLAN_COLORS,
  RESULT_COLORS,
  RESULT_LABELS,
  serviceOf,
  statusColor,
  statusInFlight,
  typeName,
} from "../theme.ts";
import { safeUI, uiCtxOf, useRegistry } from "../uiRegistry.ts";
import {
  useApproval,
  useDeploymentLive,
  useDeploymentStartedAt,
  useIsSelected,
  useMeta,
  useNode,
} from "../store.ts";
import { ResourceIcon } from "./Icon.tsx";

export type CanvasNode = Node<{ fqn: string }, "resource">;

export { NODE_HEIGHT, NODE_WIDTH };

// ── cached style fragments (stable identity inside the memoized node) ──
const bgCache = new Map<string, CSSProperties>();
const bgOf = (color: string): CSSProperties => {
  let style = bgCache.get(color);
  if (style === undefined) {
    style = { background: color };
    bgCache.set(color, style);
  }
  return style;
};

const tabCache = new Map<string, CSSProperties>();
const tabStyleOf = (color: string): CSSProperties => {
  let style = tabCache.get(color);
  if (style === undefined) {
    style = { background: color, color: "var(--alc-fg-on-accent)" };
    tabCache.set(color, style);
  }
  return style;
};

const beamCache = new Map<string, CSSProperties>();
const beamStyleOf = (color: string): CSSProperties => {
  let style = beamCache.get(color);
  if (style === undefined) {
    style = { "--beam-color": color } as CSSProperties;
    beamCache.set(color, style);
  }
  return style;
};

// hollow variant: a PENDING phase is a promise, not yet real — outlined
// tab with a soft wash of the action color
const tabOutlineCache = new Map<string, CSSProperties>();
const tabOutlineStyleOf = (color: string): CSSProperties => {
  let style = tabOutlineCache.get(color);
  if (style === undefined) {
    style = {
      color,
      borderColor: color,
      background: `color-mix(in srgb, ${color} 12%, var(--alc-bg-elev-2))`,
    };
    tabOutlineCache.set(color, style);
  }
  return style;
};

// card shells — hoisted class strings, no per-render string building beyond
// a ternary pick. Hover lifts shadow + hairline; selection is an inline
// --alc-glow ring (inline style wins over the hover class, so the ring
// persists while hovered).
const CARD_BASE =
  "rounded-[var(--alc-radius-lg)] border px-3.5 py-2.5 bg-[var(--alc-bg-elev-2)] transition-[border-color,box-shadow,opacity] duration-[var(--alc-dur)] ease-[var(--alc-ease)]";
const CARD_SOLID = `${CARD_BASE} border-[var(--alc-hairline-2)] shadow-[var(--alc-shadow-sm)] hover:border-[var(--alc-hairline-3)] hover:shadow-[var(--alc-shadow)]`;
const CARD_SOLID_SELECTED = `${CARD_BASE} border-[var(--alc-accent-60)]`;
// structure ghosts / deleted / pending-plan cards: the DASHED border is
// what says "doesn't exist (yet/anymore)" — strong enough to read, no fade
const CARD_GHOST = `${CARD_BASE} border-dashed border-[var(--alc-fg-4)] shadow-[var(--alc-shadow-sm)]`;
const CARD_GHOST_SELECTED = `${CARD_BASE} border-dashed border-[var(--alc-accent-60)]`;

// node-scale chip: same soft-wash recipe as the shared CHIP snippet, sized
// down for the dense canvas card.
const NODE_CHIP =
  "mt-1.5 inline-block rounded-[var(--alc-radius-sm)] px-1.5 py-px text-[10px] font-medium";

const BINDING_CHIP_COLOR = "var(--alc-terracotta)";

const HANDLE_CLASS = "!bg-[var(--alc-fg-4)] !border-none !w-1.5 !h-1.5";

// Two lanes per side so opposing edges (circular bindings A ⇄ B) render as
// clean parallel arrows (→ above, ← below) instead of one edge wrapping
// around the whole graph. Forward edges ride the upper lane (out of the
// right side, into the left); backward edges ride the lower lane (out of
// the LEFT side, into the RIGHT). The Canvas picks lanes per edge from the
// laid-out node positions.
const LANE_FORWARD = { top: "38%" } as const;
const LANE_BACKWARD = { top: "66%" } as const;

export const ResourceNode = memo(function ResourceNode({
  data,
}: NodeProps<CanvasNode>) {
  const { fqn } = data;
  const { node, decoration } = useNode(fqn);
  const selected = useIsSelected(fqn);
  const meta = useMeta();
  const registry = useRegistry();
  const approval = useApproval();
  const deployStartedAt = useDeploymentStartedAt();
  const live = useDeploymentLive();

  // live overlay wins over the structural baseline
  const rawStatus = decoration?.status ?? node?.status ?? "unknown";
  const status =
    node?.kind === "action" &&
    (rawStatus === "deleting" || rawStatus === "deleted")
      ? (node?.status ?? "unknown")
      : rawStatus;
  const ui = node !== undefined ? registry?.get(node.type) : undefined;

  // UIProvider hooks are pure functions of the ctx — memoized on the node's
  // structural identity + decoration-driven status, so they re-run only
  // when THIS node's slice changes (the component itself is memo'd and
  // renders only on its own subscriptions).
  const ctx = useMemo<ResourceUIContext | undefined>(
    () => (node === undefined ? undefined : uiCtxOf(node, status, meta)),
    [node, status, meta],
  );
  const summary = useMemo(
    () =>
      ui?.summary !== undefined && ctx !== undefined
        ? safeUI(() => ui.summary?.(ctx))
        : undefined,
    [ui, ctx],
  );
  const link = useMemo(
    () =>
      ui?.link !== undefined && ctx !== undefined
        ? safeUI(() => ui.link?.(ctx))
        : undefined,
    [ui, ctx],
  );

  if (node === undefined || ctx === undefined) {
    // transient: the flow-node array still holds an fqn a structure-replace
    // just retired; the next commit removes it
    return null;
  }

  const Card = ui?.Card;
  const color = ui?.color ?? CLOUD_COLORS[cloudOf(node.type)] ?? NEUTRAL_COLOR;
  const plan = decoration?.planAction ?? node.planAction;
  // A deleted task is a pure state drop: the destroy story deliberately
  // excludes actions (they never run during teardown), so the ghost that
  // returns after the run must not wear the destroy's verdict — and
  // "deleting"/"deleted" are not real lifecycle phases for it either.
  const isAction = node.kind === "action";
  const result =
    isAction && decoration?.applyResult === "deleted"
      ? undefined
      : decoration?.applyResult;
  const note = decoration?.note;
  const hidden = decoration?.hidden === true;
  const planColor = plan ? PLAN_COLORS[plan] : undefined;
  const resultColor = result ? RESULT_COLORS[result] : undefined;
  // Pending plan wins over the PREVIOUS run's result: while approval is
  // pending, or while the node's result predates the current deployment
  // record, show what WILL happen. A result landed by the current run
  // (decoration newer than the run's start) takes over as each node
  // completes.
  const resultIsFresh =
    result !== undefined &&
    deployStartedAt !== undefined &&
    (decoration?.at ?? 0) >= deployStartedAt;
  const showPlanChip =
    plan !== undefined && (approval !== undefined || !resultIsFresh);
  // The bookmark tab is the node's single lifecycle indicator:
  //   this run's live status (spinner: pending → creating → …)
  //   > pending plan > result from the current run.
  // Historical results (previous runs) stay as the muted in-card chip.
  //
  // A "live status" must be DECORATED BY THE CURRENT LIVE RUN — a
  // persisted baseline status like "deleting" left behind by a failed
  // destroy would otherwise masquerade as live forever and mask the
  // pending plan action ("delete") on the next attempt.
  const rawRunStatus =
    live &&
    decoration?.status !== undefined &&
    deployStartedAt !== undefined &&
    (decoration.at ?? 0) >= deployStartedAt
      ? decoration.status
      : undefined;
  const runStatus =
    isAction && (rawRunStatus === "deleting" || rawRunStatus === "deleted")
      ? undefined
      : rawRunStatus;
  const inFlight = runStatus !== undefined && statusInFlight(runStatus);
  // queued this run: waiting for its turn — spins in the plan's color
  const queued = runStatus === "pending";
  // Phase treatment (color is ALWAYS the action's). FILLED means SETTLED —
  // everything unsettled stays hollow, so an in-flight tab can never be
  // mistaken for a terminal one:
  //   plan     → hollow, still (a quiet promise)
  //   queued   → hollow + spinner (waiting in line)
  //   doing    → hollow + pulsing dot (live activity)
  //   complete → FILLED + ✓ (✗ for failed) — the only bold tab
  const planTab =
    showPlanChip && plan !== undefined && planColor !== undefined
      ? {
          label: plan,
          color: planColor,
          hollow: true,
          spinner: false,
          glyph: undefined,
        }
      : undefined;
  const tab = inFlight
    ? {
        label: status,
        color: inFlightColor(status, plan),
        hollow: true,
        spinner: false,
        glyph: "dot" as const,
      }
    : queued
      ? {
          label: "pending",
          color: planColor ?? statusColor("pending"),
          hollow: true,
          spinner: true,
          glyph: undefined,
        }
      : approval !== undefined
        ? // the review screen shows ONLY what WILL happen: plan tabs on
          // affected nodes, NOTHING on no-ops (a stale "created" would
          // read as pending work)
          planTab
        : resultIsFresh && result !== undefined && resultColor !== undefined
          ? {
              label: result,
              color: resultColor,
              hollow: false,
              spinner: false,
              glyph:
                result === "failed" ? ("cross" as const) : ("check" as const),
            }
          : planTab;
  // terminated / declared-only resources render "dead": dashed ghost shell
  const deleted = result === "deleted" || status === "deleted";
  const ghost = node.ghost !== undefined || deleted;
  const dashed = ghost || status === "pending";

  const cardClass = dashed
    ? selected
      ? CARD_GHOST_SELECTED
      : CARD_GHOST
    : selected
      ? CARD_SOLID_SELECTED
      : CARD_SOLID;

  return (
    <div
      className={`relative ${cardClass}`}
      style={{
        width: NODE_WIDTH,
        // accent glow ring — inline so it wins over the hover shadow class
        boxShadow: selected ? "var(--alc-glow)" : undefined,
        // the lifecycle tab outlines the whole card in its color
        // (selection still wins)
        borderColor: !selected && tab !== undefined ? tab.color : undefined,
        // "doesn't exist (yet/anymore)" is carried by the DASHED BORDER and
        // title color, never by fading the whole card — text and borders
        // stay crisp in both themes. `hidden` is the one exception (an
        // explicit server-side hide).
        opacity: hidden ? 0.2 : undefined,
      }}
    >
      {/* border beam: a light of the action color orbits the card while a
          lifecycle operation is actively running */}
      {inFlight && tab !== undefined && (
        <span className="node-beam" style={beamStyleOf(tab.color)} />
      )}
      {/* bookmark tab: the node's lifecycle at a glance, flush on the
          card's top edge like an index tab — "update" (pending) →
          "updating" + spinner (running) → "updated"/"failed" (this run) */}
      {tab !== undefined && (
        <div
          className={`absolute -top-[19px] left-3 flex items-center gap-1 rounded-t-[var(--alc-radius-sm)] px-2 pb-[3px] pt-[2px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] ${
            tab.hollow ? "border border-b-0" : ""
          }`}
          style={
            tab.hollow ? tabOutlineStyleOf(tab.color) : tabStyleOf(tab.color)
          }
        >
          {tab.spinner && <Loader2 size={9} className="animate-spin" />}
          {tab.glyph === "dot" && (
            <span className="status-pulse h-1.5 w-1.5 rounded-full bg-current" />
          )}
          {tab.glyph === "check" && <Check size={9} strokeWidth={3} />}
          {tab.glyph === "cross" && <X size={9} strokeWidth={3} />}
          {tab.label}
        </div>
      )}
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        style={LANE_FORWARD}
        className={HANDLE_CLASS}
      />
      <Handle
        id="in-back"
        type="target"
        position={Position.Right}
        style={LANE_BACKWARD}
        className={HANDLE_CLASS}
      />
      <div className="flex items-center gap-2">
        <ResourceIcon ui={ui} color={color} size={16} kind={node.kind} />
        <span className="truncate text-[13px] font-semibold text-[var(--alc-fg-1)]">
          {node.logicalId}
        </span>
        <span
          className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
            inFlight || queued ? "status-pulse" : ""
          }`}
          style={bgOf(
            statusInFlight(status)
              ? inFlightColor(status, plan)
              : statusColor(status),
          )}
          title={status}
        />
      </div>
      <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--alc-fg-3)]">
        {serviceOf(node.type)
          ? `${serviceOf(node.type)}.${typeName(node.type)}`
          : typeName(node.type)}
        {summary ? (
          <span className="text-[var(--alc-fg-2)]"> · {summary}</span>
        ) : null}
      </div>
      {Card ? (
        <div className="mt-1.5">
          <Card ctx={ctx} />
        </div>
      ) : link ? (
        <div className="mt-1 truncate">
          {/* real anchor, clickable straight from the canvas: `nodrag`
              stops React Flow from treating pointerdown as a drag start,
              stopPropagation keeps the click from also selecting the node */}
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={link}
            className="nodrag font-mono text-[10.5px] text-[var(--alc-info)] transition-colors duration-[var(--alc-dur-fast)] hover:text-[var(--alc-accent-deep)] hover:underline"
          >
            {link}
          </a>
        </div>
      ) : null}
      {note && statusInFlight(status) && (
        <div
          className="mt-1 truncate text-[10.5px] text-[var(--alc-warn)]"
          title={note}
        >
          {note}
        </div>
      )}
      <div className="flex gap-1">
        {/* the bookmark tab carries live state; the in-card chip keeps
            only HISTORICAL results (previous runs, idle graph) */}
        {tab === undefined && result && resultColor ? (
          <span
            className={NODE_CHIP}
            style={chipStyle(resultColor)}
            title={`last deploy: ${result}`}
          >
            {RESULT_LABELS[result]}
          </span>
        ) : null}
        {node.bindings.length > 0 && (
          <span className={NODE_CHIP} style={chipStyle(BINDING_CHIP_COLOR)}>
            {node.bindings.length} binding{node.bindings.length > 1 ? "s" : ""}
          </span>
        )}
      </div>
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        style={LANE_FORWARD}
        className={HANDLE_CLASS}
      />
      <Handle
        id="out-back"
        type="source"
        position={Position.Left}
        style={LANE_BACKWARD}
        className={HANDLE_CLASS}
      />
    </div>
  );
});
