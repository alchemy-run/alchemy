import type { AppId } from "../shared/types.ts";

/** The two panes of the demo terminal. */
export type Pane = "dev" | "shell";

export interface Term {
  /** Type a command into a pane (character by character) and press Enter. */
  type(pane: Pane, command: string): Promise<void>;
  /** Press a key in a pane, e.g. `Enter`. */
  key(pane: Pane, key: string): Promise<void>;
  /** Type a command in the shell pane and wait for it to finish (or for `until`). Returns the pane text. */
  run(command: string, opts?: { until?: RegExp; timeout?: number }): Promise<string>;
  /** Wait until `alchemy dev` in the top pane has settled after a change. */
  waitDev(opts?: { timeout?: number }): Promise<void>;
  /** Wait until a pane shows `pattern`. */
  waitFor(pane: Pane, pattern: RegExp, opts?: { timeout?: number }): Promise<string>;
  /** Current text of a pane, including scrollback. */
  text(pane: Pane): Promise<string>;
  sleep(ms: number): Promise<void>;
}

/**
 * What a chapter scene can do. Every call has a real effect on the project
 * folder, the terminal or the network, and is also recorded as a beat for
 * the video: editor edits are written to disk as they are "typed", terminal
 * commands run in a real tmux session, and pages are real captures.
 */
export interface SceneContext {
  /** Absolute path of the project folder the demo builds. */
  readonly dir: string;
  /** Values passed to later scenes (e.g. a deployed URL). */
  readonly state: Record<string, string>;
  /** Copy every file of this scene's chapter into the project, except the ones typed on screen. */
  sync(opts?: { except?: string[] }): Promise<void>;
  editor: {
    /** Open a file in a tab (or switch to its tab). */
    open(file: string): Promise<void>;
    /** Type the file's change from its current contents to the chapter's version. */
    show(file: string): Promise<void>;
    /** Delete a file (closes its tab). */
    remove(file: string): Promise<void>;
  };
  /** Drive the terminal; everything inside is shown in the terminal window. */
  terminal<T>(fn: (t: Term) => Promise<T>): Promise<T>;
  /** Show the architecture read from Alchemy's state, once it contains the expected parts. */
  diagram(opts: { stage: string; nodes?: string[]; edges?: string[] }): Promise<void>;
  browser: {
    /** Load `url` in a real browser and show it. */
    open(url: string, opts?: { waitFor?: RegExp }): Promise<void>;
    /** Re-capture the open page once it shows `waitFor` (live updates). */
    update(opts: { waitFor: RegExp }): Promise<void>;
  };
  /** Cmd-Tab to a window without doing anything in it. */
  focus(app: AppId): void;
  /** Hold on the current picture. */
  pause(seconds: number): void;
}

export interface SceneDefinition {
  title: string;
  notes?: string;
  /** Folder under `chapters/` this scene ends at. */
  chapter: string;
  run(s: SceneContext): Promise<void>;
}

export const defineScene = (scene: SceneDefinition): SceneDefinition => scene;
