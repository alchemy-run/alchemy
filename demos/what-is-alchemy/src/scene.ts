import type { Tone } from "./theme.ts";

/** A hand-drawn mark on code, with a label beside it. */
export interface Mark {
  find: string;
  kind: "circle" | "underline";
  label: string;
  tone: Tone;
}

/** One file on screen. */
export interface Pane {
  file: string;
  code: string;
  lang?: "ts" | "yaml";
  marks?: Mark[];
  /** Tint lines by phase: from the line containing `from` to the one containing `to`. */
  tints?: { from: string; to?: string; tone: Tone }[];
}

export type Scene =
  | { kind: "title"; heading: string; subtitle?: string; footer?: string }
  | { kind: "section"; heading: string }
  | {
      kind: "code";
      /** Consecutive code scenes in the same group don't re-enter, only their new marks animate. */
      group: string;
      panes: Pane[];
      /** Lines from text in the first pane to text in the second. */
      links?: { from: string; to: string; tone: Tone }[];
      /** A row of options under the code, with the current one lit. */
      reel?: { items: string[]; at: number };
    }
  | {
      kind: "pyramid";
      /** The line between the two programs. */
      cut?: boolean;
      /** One feature cut vertically through every layer. */
      slice?: { label: string; items: [string, string, string, string] };
    }
  | { kind: "terminal"; lines: { text: string; color?: string; bold?: boolean }[][] };

/** One press of →. */
export interface Step {
  /** The caption at the top of the screen (none on title and section slides). */
  title?: string;
  /** What to say. Shown in the presenter, never in the video. */
  notes: string;
  scene: Scene;
  /** How long the step's animation runs. */
  frames?: number;
}
