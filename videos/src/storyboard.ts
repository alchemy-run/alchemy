/**
 * A video is data: an ordered list of typed scenes. Storyboards are written
 * (by hand or by agents) against this schema; the engine (Video.tsx) turns
 * them into Remotion sequences. All durations are in seconds.
 */

/** One line of code with an optional diff/emphasis role. */
export interface CodeLine {
  text: string;
  /** "add" animates in (green tint); "del" renders struck (red tint). */
  mark?: "add" | "del";
  /** Soft accent wash to draw the eye once typing completes. */
  highlight?: boolean;
}

export interface ErrorCallout {
  /** 0-based line the callout attaches beneath. */
  line: number;
  text: string;
  /** Seconds into the scene when it appears (default 60% in). */
  at?: number;
  kind?: "error" | "ok";
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
      /** Typewriter reveal (default true). Diff scenes usually set false. */
      type?: boolean;
      callouts?: ErrorCallout[];
      subtitles: string[];
      duration: number;
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

export const totalFrames = (sb: Storyboard): number =>
  Math.round(sb.scenes.reduce((s, sc) => s + sc.duration, 0) * FPS);
