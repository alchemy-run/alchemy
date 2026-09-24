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
