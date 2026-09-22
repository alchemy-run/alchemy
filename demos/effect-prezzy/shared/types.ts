/**
 * The contract between the capture step (which runs the demo for real) and
 * the Remotion compositions (which draw it). Capture writes one
 * `SceneCapture` per scene to `out/capture/<scene>/scene.json`; Remotion
 * reads it with `staticFile`. Asset paths are relative to `out/capture`,
 * which is Remotion's public directory.
 */

/** Size of the rendered video. Every layout constant derives from it. */
export const VIDEO = { width: 1920, height: 1080, fps: 30 } as const;

/** One desktop window; all three share the same frame and stack by focus. */
export const WINDOW = { x: 80, y: 64, width: 1760, height: 976 } as const;
export const TITLE_BAR = 44;
/** The terminal clip fills the window below its title bar. */
export const TERMINAL = {
  width: WINDOW.width,
  height: WINDOW.height - TITLE_BAR,
} as const;
/** Chrome-style tab strip + toolbar above the page. */
export const BROWSER_CHROME = 92;
export const BROWSER_VIEWPORT = {
  width: WINDOW.width,
  height: WINDOW.height - BROWSER_CHROME,
} as const;

export type AppId = "editor" | "terminal" | "browser";

export type Beat =
  /** Bring a window to the front (Cmd-Tab). Other beats focus their own window implicitly. */
  | { kind: "focus"; app: AppId }
  /** Open (or switch to) a file tab. */
  | { kind: "editor.open"; file: string; content: string }
  /** Type the change from `before` to `after` into an open file (opened first if needed). */
  | { kind: "editor.edit"; file: string; before: string; after: string }
  /** Play `[start, end)` seconds of the scene's terminal clip. */
  | { kind: "terminal"; start: number; end: number }
  /** Type `url` into the address bar and show the captured page. */
  | { kind: "browser"; url: string; title: string; screenshot: string }
  /** Hold on the current picture. */
  | { kind: "pause"; seconds: number };

export interface SceneCapture {
  id: string;
  title: string;
  notes: string;
  /** Project folder name shown in the explorer and title bars. */
  project: string;
  /** Every project file (relative paths) that exists when the scene starts. */
  files: string[];
  /** Editor tabs already open when the scene starts, with their contents. */
  editor: { tabs: { file: string; content: string }[]; active?: string };
  /** Terminal-only render of the scene's shell session. */
  terminal: { clip: string; duration: number } | undefined;
  /** Last page shown in the browser before this scene. */
  browser: { url: string; title: string; screenshot: string } | undefined;
  beats: Beat[];
}

/** Title-card style slides, designed in React and placed between scenes. */
export interface SlideItem {
  kind: "slide";
  id: string;
  title: string;
  notes: string;
  layout: "title" | "section" | "bullets";
  props: {
    eyebrow?: string;
    heading: string;
    subtitle?: string;
    bullets?: string[];
  };
  /** Seconds the slide animates before holding. */
  seconds?: number;
}

export interface SceneItem {
  kind: "scene";
  /** Matches `scenes/<id>.ts`. */
  id: string;
}

export type DeckItem = SlideItem | SceneItem;
