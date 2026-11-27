/**
 * The building blocks of an `@alchemy.run/domain` model, and of an
 * `@alchemy.run/ai` program around it, as drawn in diagrams.
 * Each kind has one colour, one icon and one shape, used everywhere.
 */

export type Kind =
  | "command"
  | "aggregate"
  | "decision"
  | "event"
  | "view"
  | "query"
  | "projection"
  | "stream"
  | "policy"
  | "saga"
  | "rejection"
  | "external"
  | "api"
  | "client"
  | "process"
  | "tool"
  | "model"
  | "session"
  | "harness"
  | "sandbox"
  | "binding"
  | "resource";

/** How a kind's box is drawn. */
export type Shape =
  | "arrow" // a request on its way: a box pointing right
  | "arrowBack" // an answer on its way back: a box pointing left
  | "boundary" // a consistency boundary: a double outline
  | "record" // a fact on paper: a folded corner
  | "pill" // a read model: rounded ends
  | "box" // a plain box
  | "stack" // a log of entries: stacked boxes
  | "octagon" // a rule: cut corners
  | "outside" // outside the model: a dashed outline
  | "sheet" // prose on a page: a curled bottom edge
  | "hex"; // something to call: pointed ends

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
    // Sent to the model, like a paper plane.
    icon: ["M21 3L10 14", "M21 3l-6.5 18-4.5-7-7-4.5z"],
  },
  aggregate: {
    name: "Aggregate",
    hue: "#e3b341",
    shape: "boundary",
    icon: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5", "M12 12v9"],
  },
  decision: {
    name: "Decision",
    hue: "#f2a65a",
    shape: "octagon",
    // Several instances, decided as one.
    icon: ["M4 6h4l4 6h8", "M4 18h4l4-6", "M17 9l3 3-3 3"],
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
  query: {
    name: "Query",
    hue: "#e6d3a8",
    shape: "arrowBack",
    icon: ["M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z", "M20 20l-4-4"],
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
    // Entries flowing one way, like Kinesis: parallel lines into one arrowhead.
    icon: ["M3 7h11", "M3 12h17", "M3 17h11", "M17 9l3 3-3 3"],
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
  saga: {
    name: "Saga",
    hue: "#c6d84a",
    shape: "box",
    // Steps joined into one process.
    icon: ["M3 3h7v7H3z", "M14 14h7v7h-7z", "M6.5 10v4a3 3 0 0 0 3 3H14"],
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
  api: {
    name: "Api",
    hue: "#ece8df",
    shape: "box",
    // What the model publishes to the outside world.
    icon: [
      "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z",
      "M3 12h18",
      "M12 3c3 3 3 15 0 18",
      "M12 3c-3 3-3 15 0 18",
    ],
  },
  client: {
    name: "Client",
    hue: "#c3ccd6",
    shape: "outside",
    // An app or service outside the model, calling it through an Api.
    icon: ["M4 5h16v11H4z", "M2 19h20"],
  },
  process: {
    name: "Process",
    hue: "#b29bff",
    shape: "sheet",
    // Work written down as prose.
    icon: [
      "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
      "M14 3v5h5",
      "M9 13h6",
      "M9 17h6",
    ],
  },
  tool: {
    name: "Tool",
    hue: "#ff9e64",
    shape: "hex",
    icon: [
      "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
    ],
  },
  model: {
    name: "Model",
    hue: "#f5d76e",
    shape: "octagon",
    icon: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", "M19 16v4", "M17 18h4"],
  },
  session: {
    name: "Session",
    hue: "#8fd0ff",
    shape: "pill",
    // One conversation.
    icon: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  },
  harness: {
    name: "Harness",
    hue: "#e89ac7",
    shape: "box",
    // The loop that runs a session.
    icon: [
      "M17 2l4 4-4 4",
      "M3 11v-1a4 4 0 0 1 4-4h14",
      "M7 22l-4-4 4-4",
      "M21 13v1a4 4 0 0 1-4 4H3",
    ],
  },
  sandbox: {
    name: "Sandbox",
    hue: "#a3b18a",
    shape: "box",
    icon: ["M4 17l6-6-6-6", "M12 19h8"],
  },
  binding: {
    name: "Binding",
    hue: "#58c4c4",
    shape: "pill",
    // A link from code to a resource.
    icon: [
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    ],
  },
  resource: {
    name: "Resource",
    hue: "#c9c2b4",
    shape: "box",
    icon: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"],
  },
};

export const KIND_ORDER = Object.keys(KINDS) as ReadonlyArray<Kind>;
