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
import { Loader2 } from "lucide-react";
import { memo, useMemo, type CSSProperties } from "react";
import { NODE_HEIGHT, NODE_WIDTH } from "../layout/elkGraph.ts";
import {
  chipStyle,
  CLOUD_COLORS,
  cloudOf,
  NEUTRAL_COLOR,
  PLAN_COLORS,
  PLAN_LABELS,
  RESULT_COLORS,
  RESULT_LABELS,
  serviceOf,
  statusColor,
  statusInFlight,
  typeName,
} from "../theme.ts";
import { safeUI, uiCtxOf, useRegistry } from "../uiRegistry.ts";
import { useIsSelected, useMeta, useNode } from "../store.ts";
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

const fgCache = new Map<string, CSSProperties>();
const fgOf = (color: string): CSSProperties => {
  let style = fgCache.get(color);
  if (style === undefined) {
    style = { color };
    fgCache.set(color, style);
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

export const ResourceNode = memo(function ResourceNode({
  data,
}: NodeProps<CanvasNode>) {
  const { fqn } = data;
  const { node, decoration } = useNode(fqn);
  const selected = useIsSelected(fqn);
  const meta = useMeta();
  const registry = useRegistry();

  // live overlay wins over the structural baseline
  const status = decoration?.status ?? node?.status ?? "unknown";
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
  const result = decoration?.applyResult;
  const note = decoration?.note;
  const hidden = decoration?.hidden === true;
  const planColor = plan ? PLAN_COLORS[plan] : undefined;
  const resultColor = result ? RESULT_COLORS[result] : undefined;
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
      className={cardClass}
      style={{
        width: NODE_WIDTH,
        // accent glow ring — inline so it wins over the hover shadow class
        boxShadow: selected ? "var(--alc-glow)" : undefined,
        // "doesn't exist (yet/anymore)" is carried by the DASHED BORDER and
        // title color, never by fading the whole card — text and borders
        // stay crisp in both themes. `hidden` is the one exception (an
        // explicit server-side hide).
        opacity: hidden ? 0.2 : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <div className="flex items-center gap-2">
        <ResourceIcon ui={ui} color={color} size={16} />
        <span
          className={`truncate text-[13px] font-semibold ${
            deleted ? "text-[var(--alc-danger)]" : "text-[var(--alc-fg-1)]"
          }`}
        >
          {node.logicalId}
        </span>
        {statusInFlight(status) ? (
          <Loader2
            size={13}
            className="ml-auto shrink-0 animate-spin"
            style={fgOf(statusColor(status))}
            aria-label={status}
          />
        ) : (
          <span
            className="ml-auto h-2 w-2 shrink-0 rounded-full"
            style={bgOf(statusColor(status))}
            title={status}
          />
        )}
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
        <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--alc-info)]">
          {link}
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
        {result && resultColor && (
          <span
            className={NODE_CHIP}
            style={chipStyle(resultColor)}
            title={`last deploy: ${result}`}
          >
            {RESULT_LABELS[result]}
          </span>
        )}
        {plan && !result && planColor && (
          <span className={NODE_CHIP} style={chipStyle(planColor)}>
            {PLAN_LABELS[plan]}
          </span>
        )}
        {node.bindings.length > 0 && (
          <span className={NODE_CHIP} style={chipStyle(BINDING_CHIP_COLOR)}>
            {node.bindings.length} binding{node.bindings.length > 1 ? "s" : ""}
          </span>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={HANDLE_CLASS}
      />
    </div>
  );
});
