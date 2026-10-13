/**
 * The building blocks of an `alchemy/Domain` model, as drawn in diagrams.
 * Each kind has one colour, one icon and one shape, used everywhere.
 */

export type Kind =
  | "command"
  | "aggregate"
  | "event"
  | "view"
  | "projection"
  | "stream"
  | "policy"
  | "rejection"
  | "external";

/** How a kind's box is drawn. */
export type Shape =
  | "arrow" // a request on its way: a box pointing right
  | "boundary" // a consistency boundary: a double outline
  | "record" // a fact on paper: a folded corner
  | "pill" // a read model: rounded ends
  | "box" // a plain box
  | "stack" // a log of entries: stacked boxes
  | "octagon" // a rule: cut corners
  | "outside"; // outside the model: a dashed outline

export interface KindStyle {
  readonly name: string;
  readonly hue: string;
  readonly shape: Shape;
  /** Icon paths in a 24×24 box, stroked. */
  readonly icon: ReadonlyArray<string>;
}

export const KINDS: Record<Kind, KindStyle> = {
  command: {
    name: "Command",
    hue: "#4f9fd8",
    shape: "arrow",
    icon: ["M4 12h15", "M13 6l6 6-6 6"],
  },
  aggregate: {
    name: "Aggregate",
    hue: "#e3b341",
    shape: "boundary",
    icon: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5", "M12 12v9"],
  },
  event: {
    name: "Event",
    hue: "#f0782f",
    shape: "record",
    icon: ["M13 2L4 14h7l-1 8 9-12h-7z"],
  },
  view: {
    name: "View",
    hue: "#7fb069",
    shape: "pill",
    icon: [
      "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z",
      "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
    ],
  },
  projection: {
    name: "Projection",
    hue: "#3fb8af",
    shape: "box",
    icon: [
      "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z",
      "M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
      "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    ],
  },
  stream: {
    name: "Stream",
    hue: "#9aa7c7",
    shape: "stack",
    icon: ["M4 6h16", "M4 12h16", "M4 18h10"],
  },
  policy: {
    name: "Policy",
    hue: "#a78bdb",
    shape: "octagon",
    icon: [
      "M12 3v18",
      "M6 21h12",
      "M5 7h14",
      "M5 7l-3 7a3 3 0 0 0 6 0z",
      "M19 7l-3 7a3 3 0 0 0 6 0z",
    ],
  },
  rejection: {
    name: "Rejection",
    hue: "#e5484d",
    shape: "box",
    icon: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M9 9l6 6", "M15 9l-6 6"],
  },
  external: {
    name: "External system",
    hue: "#d97aa8",
    shape: "outside",
    icon: ["M9 2v6", "M15 2v6", "M6 8h12v4a6 6 0 0 1-12 0z", "M12 18v4"],
  },
};

export const KIND_ORDER = Object.keys(KINDS) as ReadonlyArray<Kind>;
