/**
 * A video is data: an ordered list of typed scenes. Storyboards are written
 * (by hand or by agents) against this schema; the engine (Video.tsx) turns
 * them into Remotion sequences. All durations are in seconds.
 */

/**
 * One line of code. The full file renders instantly; beat indices drive
 * where attention goes and when diff lines splice in.
 */
export interface CodeLine {
  text: string;
  /** Beat index at which this line splices in as a "+" line (green). */
  appearAt?: number;
  /** Beat index at which this line is struck through as a "-" line (red). */
  delAt?: number;
  /** Beat indices during which this line is spotlit (others dim). */
  focusAt?: number[];
}

/**
 * One beat of narration. The subtitle changes, focused lines light up,
 * pending diff lines splice in — all on the same cut.
 */
export interface Beat {
  subtitle: string;
  duration: number;
  /** Callout box pinned beneath a line (0-based, counted in final layout). */
  callout?: {
    line: number;
    text: string;
    kind?: "error" | "ok";
  };
}

export interface TerminalRow {
  /** e.g. "Bucket" */
  id: string;
  /** e.g. "Cloudflare.R2.Bucket" */
  type: string;
  verb?: "create" | "delete";
}

export type Scene =
  | {
      kind: "title";
      eyebrow?: string;
      title: string;
      sub?: string;
      duration: number;
    }
  | {
      kind: "code";
      file: string;
      lines: CodeLine[];
      /** Narration beats; scene duration = sum of beat durations. */
      beats: Beat[];
    }
  | {
      kind: "terminal";
      command: string;
      /** Header line above rows, e.g. "Apply  2 to create" */
      header?: string;
      rows?: TerminalRow[];
      /** Plain output lines (for curl-style scenes). */
      output?: string[];
      /** Summary line rendered in accent, e.g. a URL. */
      summary?: string;
      subtitles: string[];
      duration: number;
    }
  | {
      kind: "end";
      title: string;
      url: string;
      note?: string;
      duration: number;
    };

export interface Storyboard {
  id: string;
  scenes: Scene[];
}

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const sceneDuration = (sc: Scene): number =>
  sc.kind === "code" ? sc.beats.reduce((s, b) => s + b.duration, 0) : sc.duration;

export const totalFrames = (sb: Storyboard): number =>
  Math.round(sb.scenes.reduce((s, sc) => s + sceneDuration(sc), 0) * FPS);
