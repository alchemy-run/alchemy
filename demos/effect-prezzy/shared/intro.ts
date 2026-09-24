/**
 * The intro, resolved: `intro/build.ts` turns the authored steps
 * (`intro/steps.ts`) into this JSON (tokens highlighted, marks and type
 * errors located), and the Remotion `Intro` composition renders it. Every
 * step is one press of → in the presenter.
 */

export interface Token {
  text: string;
  color: string;
}

export type Tone = "construct" | "runtime" | "good" | "bad" | "neutral";

/** A hand-drawn mark over a range of code (0-based line/column). */
export interface Mark {
  kind: "circle" | "underline" | "strike" | "box" | "highlight";
  line: number;
  col: number;
  len: number;
  /** For multi-line boxes: the last line covered. */
  toLine?: number;
  label?: string;
  side?: "right" | "left" | "above" | "below";
  tone?: Tone;
}

export interface CodeError {
  line: number;
  col: number;
  len: number;
  code: string;
  message: string[];
}

export interface PanelItem {
  title: string;
  body?: string;
  mono?: string;
  tone?: Tone;
  /** 0–1: draws a proportional bar (illustrative sizes). */
  bar?: number;
}

/** One entry of an Effect's `Req`: open until something provides it. */
export interface ReqItem {
  /** The requirement's type name, as the compiler prints it. */
  name: string;
  state?: "open" | "met" | "bad";
  /** Short text beside it: what it's for, or what satisfies it. `\n` breaks lines. */
  note?: string;
}

/** The requirements of the code on screen, listed beside it. */
export interface ReqPanel {
  label: string;
  items: ReqItem[];
  /** Other Effects' Req, each under its own small heading below `items`. */
  parts?: { label: string; items: ReqItem[] }[];
}

/** A value threaded down a call chain, drawn beside the code. */
export interface Drill {
  /** Small heading above the chain. */
  label: string;
  /** The value being passed down: highlighted and threaded wherever it appears. */
  name: string;
  /** One call per line, outermost first; leading spaces set the depth. */
  lines: string[];
  /** Hand-written note under the chain. */
  note?: string;
}

/** A small architecture drawing beside the code: it evolves with the code. */
export interface MiniNode {
  id: string;
  title: string;
  color: string;
  /** Centre, in pixels inside the drawing area. */
  x: number;
  y: number;
  /** Config lines under the node; lines new in this step appear in green. */
  notes?: string[];
  /** A hypothetical node: dashed outline, e.g. "what would this even be?" */
  ghost?: boolean;
}

export interface MiniGraph {
  nodes: MiniNode[];
  /** `label` sits on the arrow: the permission that connection grants. */
  edges: { from: string; to: string; tone?: Tone; label?: string }[];
  /** Short facts shown under the drawing (permissions, env vars, errors). */
  cards?: { text: string; tone?: Tone }[];
  /** Requests arriving at a node from outside, drawn as a looping stream. */
  incoming?: { to: string; label: string; tone?: Tone };
  /** A dashed frame around the whole drawing, e.g. "everything construction builds". */
  frame?: { label: string; tone?: Tone };
  /** Hand-written labels at a position in the drawing. */
  labels?: {
    /** `\n` breaks lines. */
    text: string;
    x: number;
    y: number;
    tone?: Tone;
    /** Hand-drawn arrows from the label to what it's about. */
    arrows?: { from: [number, number]; to: [number, number] }[];
  }[];
}

export interface CodeStep {
  kind: "code";
  title: string;
  notes: string;
  /** Consecutive code steps in the same group morph into each other. */
  group: string;
  /** File name on the editor tab, or undefined for a pseudo-code block. */
  file?: string;
  /** The imagined language: labelled as such on screen. */
  pseudo?: boolean;
  lines: Token[][];
  fontSize: number;
  tints: { from: number; to: number; tone: Tone }[];
  focus?: { from: number; to: number };
  marks: Mark[];
  error?: CodeError;
  panel?: { title: string; items: PanelItem[] };
  diagram?: MiniGraph;
  drill?: Drill;
  req?: ReqPanel;
  /** No change highlight or spotlight on this step. */
  quiet?: boolean;
  frames: number;
}

export interface SlideStep {
  kind: "slide";
  title: string;
  notes: string;
  layout: "title" | "section";
  eyebrow?: string;
  heading: string;
  subtitle?: string;
  frames: number;
}

export interface BoardStep {
  kind: "board";
  title: string;
  notes: string;
  board: string;
  stage: number;
  frames: number;
}

export type IntroStep = CodeStep | SlideStep | BoardStep;

export interface IntroJson {
  steps: IntroStep[];
}

/** Frame ranges of each step, back to back. */
export const introTimeline = (steps: IntroStep[]) => {
  let from = 0;
  return steps.map((step) => {
    const range = { from, to: from + step.frames };
    from = range.to;
    return range;
  });
};
