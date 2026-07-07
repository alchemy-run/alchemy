/**
 * Shared theme API for the dashboard — every color is a CSS custom
 * property string over the --alc-* design tokens (src/styles/tokens.css),
 * so light/dark both work "by construction": [data-theme] flips the vars
 * and every consumer re-colors for free, with ZERO JS theme branching.
 *
 * Conventions for consumers (phase-B restyles):
 * - never concatenate alpha onto colors (`${color}1f` is dead — colors are
 *   var() strings now). Use `wash(color)` for soft chip/badge backgrounds
 *   or `chipStyle(color)` for the full { color, background } pair.
 * - `chipStyle` returns a CACHED object per color — stable identity, safe
 *   to pass into memoized React Flow nodes without breaking memoization.
 * - class-name snippets (EYEBROW, SERIF_HEADING, CHIP, PANEL, MENU_ITEM,
 *   HAIRLINE_BUTTON, SUNK_INPUT) keep the brand styling identical across
 *   components — compose them with layout utilities.
 */
import type { CSSProperties } from "react";
import type { UICategory } from "alchemy/UI/UIProvider";

// ─────────────────────────────────────────────────────────── brand colors

/**
 * Brand fallback colors per cloud prefix (first segment of the type).
 * Deliberately theme-independent — these are vendor brand hues, not
 * semantic UI colors.
 */
export const CLOUD_COLORS: Record<string, string> = {
  AWS: "#FF9900",
  Cloudflare: "#F6821F",
  GitHub: "#9198a1",
  Neon: "#00E599",
  PlanetScale: "#f97316",
  Planetscale: "#f97316",
  Axiom: "#3b82f6",
  Docker: "#2496ED",
};

/** Fallback node/icon color when no UIProvider color and no cloud match. */
export const NEUTRAL_COLOR = "var(--alc-muted)";

/** Default lucide icon per category. */
export const CATEGORY_ICONS: Record<UICategory, string> = {
  compute: "cpu",
  storage: "hard-drive",
  database: "database",
  network: "network",
  dns: "globe",
  queue: "list-ordered",
  eventing: "zap",
  ai: "sparkles",
  auth: "key-round",
  security: "shield",
  observability: "activity",
  cdn: "cloud",
  email: "mail",
  media: "image",
  config: "settings-2",
  billing: "credit-card",
  other: "box",
};

// ──────────────────────────────────────────────────────── semantic colors

/** What a deploy WOULD do — create moss, update honey, replace/delete brick. */
export const PLAN_COLORS: Record<string, string> = {
  create: "var(--alc-success)",
  update: "var(--alc-warn)",
  replace: "var(--alc-danger)",
  delete: "var(--alc-danger)",
  // tasks read as info — the same hue carries running/ran
  run: "var(--alc-info)",
};

export const PLAN_LABELS: Record<string, string> = {
  create: "+ create",
  update: "~ update",
  replace: "↻ replace",
  delete: "− delete",
  run: "▸ run",
};

/**
 * What the last apply DID (terminal results). Color = the ACTION, same as
 * the plan/in-flight phases (one hue per story; deletions stay brick even
 * when they succeed). The PHASE is carried by the tab's treatment: hollow
 * (pending) → filled + spinner (doing) → filled + ✓/✗ (complete).
 */
export const RESULT_COLORS: Record<string, string> = {
  created: "var(--alc-success)",
  updated: "var(--alc-warn)",
  replaced: "var(--alc-danger)",
  deleted: "var(--alc-danger)",
  // an executed task reads as info (same hue as its "running" phase)
  ran: "var(--alc-info)",
  retained: "var(--alc-muted)",
  failed: "var(--alc-danger)",
  // "skipped" is deliberately absent: a no-op earns no result tab
};

export const RESULT_LABELS: Record<string, string> = {
  created: "✓ created",
  updated: "✓ updated",
  replaced: "↻ replaced",
  deleted: "− deleted",
  ran: "✓ ran",
  retained: "◦ retained",
  failed: "✗ failed",
};

const IN_FLIGHT = new Set([
  "creating",
  "updating",
  "replacing",
  "deleting",
  "running",
  "pre-creating",
  "creating replacement",
  "attaching",
  "post-attach",
]);

/** Timeline/live status → token color (in-flight statuses read as honey). */
export const statusColor = (status: string): string => {
  switch (status) {
    case "created":
    case "updated":
    case "ran":
      return "var(--alc-success)";
    case "fail":
      return "var(--alc-danger)";
    case "replaced":
    case "deleted":
    case "skipped":
      return "var(--alc-muted)";
    case "deleting":
      return "var(--alc-danger)";
    default:
      return IN_FLIGHT.has(status) ? "var(--alc-warn)" : "var(--alc-muted)";
  }
};

export const statusInFlight = (status: string): boolean =>
  IN_FLIGHT.has(status);

/**
 * Which ACTION an in-flight status belongs to. The lifecycle tab keeps ONE
 * color through an action's whole story (create = moss from PENDING through
 * CREATING to CREATED); the text + spinner carry the phase.
 */
const STATUS_ACTION: Record<string, string> = {
  creating: "create",
  "pre-creating": "create",
  updating: "update",
  replacing: "replace",
  "creating replacement": "replace",
  deleting: "delete",
  attaching: "update",
  "post-attach": "update",
};

/** Action-consistent color for an in-flight status (tasks read as info). */
export const inFlightColor = (status: string, planAction?: string): string => {
  if (status === "running") {
    return "var(--alc-info)";
  }
  const action = STATUS_ACTION[status] ?? planAction;
  return (
    (action !== undefined ? PLAN_COLORS[action] : undefined) ??
    "var(--alc-warn)"
  );
};

// ────────────────────────────────────────────────────────── color helpers

/**
 * Soft wash of a color for chip/badge backgrounds — the token-era
 * replacement for the old `${hex}1f` alpha-suffix trick. Works with any
 * CSS color, including var() strings.
 */
export const wash = (color: string, percent = 16): string =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

const chipStyleCache = new Map<string, CSSProperties>();

/**
 * `{ color, background: wash(color) }` for a result/plan chip. The object
 * is cached per color — STABLE identity, so it is safe inside memoized
 * React Flow nodes (no fresh style object per render).
 */
export const chipStyle = (color: string): CSSProperties => {
  let style = chipStyleCache.get(color);
  if (style === undefined) {
    // 22% wash: 16% read washed-out on parchment (and on dark walnut) —
    // chips need enough pigment to register as status, not decoration.
    style = { color, background: wash(color, 22) };
    chipStyleCache.set(color, style);
  }
  return style;
};

const badgeStyleCache = new Map<string, CSSProperties>();

/**
 * Chip + hairline border in the same hue (Inspector-style outlined badge).
 * Cached per color, same identity guarantees as `chipStyle`.
 */
export const badgeStyle = (color: string): CSSProperties => {
  let style = badgeStyleCache.get(color);
  if (style === undefined) {
    style = {
      color,
      background: wash(color, 12),
      borderColor: wash(color, 33),
    };
    badgeStyleCache.set(color, style);
  }
  return style;
};

// ───────────────────────────────────────────────── class-name snippets

/**
 * Eyebrow label — section headers (APPLIED, FAILURES, OUTPUTS, timeline
 * headers): mono, small, uppercase, wide-tracked, deep accent.
 */
export const EYEBROW =
  "font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--alc-accent-deep)]";

/** Muted eyebrow — same shape, walnut instead of accent (secondary rows). */
export const EYEBROW_MUTED =
  "font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--alc-fg-4)]";

/**
 * Identity-carrying heading (Summary deployment header, view titles,
 * empty states) — the brand serif. Add a text size per use.
 */
export const SERIF_HEADING =
  "font-serif font-medium tracking-[-0.01em] text-[var(--alc-fg-1)]";

/** Chip shape — pair with `chipStyle(color)` / `badgeStyle(color)`. */
export const CHIP =
  "rounded-[var(--alc-radius-sm)] px-2 py-0.5 text-[11px] font-medium";

/** Elevated dropdown/popover panel. */
export const PANEL =
  "rounded-[var(--alc-radius-lg)] border border-[var(--alc-hairline-2)] bg-[var(--alc-bg-elev-2)] shadow-[var(--alc-shadow-lg)]";

/** Row inside a PANEL. */
export const MENU_ITEM =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--alc-fg-2)] transition-colors duration-[var(--alc-dur-fast)] hover:bg-[var(--alc-accent-12)]";

/** Ghost/outline button chrome (Fit, theme toggle, pickers). */
export const HAIRLINE_BUTTON =
  "rounded-[var(--alc-radius)] border border-[var(--alc-hairline-3)] text-[var(--alc-fg-2)] transition-colors duration-[var(--alc-dur)] hover:border-[var(--alc-fg-4)] hover:text-[var(--alc-fg-1)]";

/** Sunk input (filter box, panel search fields). */
export const SUNK_INPUT =
  "rounded-[var(--alc-radius)] border border-[var(--alc-hairline-2)] bg-[var(--alc-bg-sunk)] font-mono text-[12px] text-[var(--alc-fg-1)] placeholder:text-[var(--alc-fg-4)] focus:outline-none focus:border-[var(--alc-accent-60)]";

// ─────────────────────────────────────────────────────── type helpers

/** Last segment of a resource type: "AWS.S3.Bucket" -> "Bucket". */
export const typeName = (type: string): string =>
  type.split(".").at(-1) ?? type;

/** First segment: "AWS.S3.Bucket" -> "AWS". */
export const cloudOf = (type: string): string => type.split(".")[0] ?? type;

/** Middle segments: "AWS.S3.Bucket" -> "S3". */
export const serviceOf = (type: string): string =>
  type.split(".").slice(1, -1).join(".");
