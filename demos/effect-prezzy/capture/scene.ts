import type { TerminalSession } from "tcut";
import type { AppId } from "../shared/types.ts";

/**
 * What a scene script can do. Every call has a real effect on the project
 * folder, the shell or the network, and is also recorded as a beat for the
 * video: editor edits are written to disk before they are "typed", terminal
 * commands run in a real shell, and browser pages are real captures.
 */
export interface SceneContext {
  /** Absolute path of the project folder the demo builds. */
  readonly dir: string;
  /** Values passed to later scenes (e.g. a deployed URL). */
  readonly state: Record<string, string>;
  /** Current contents of a project file. */
  read(file: string): Promise<string>;
  editor: {
    /** Open a file in a tab (or switch to its tab). */
    open(file: string): Promise<void>;
    /** Write new contents to a file; the video types the difference. */
    edit(
      file: string,
      next: string | ((current: string) => string),
    ): Promise<void>;
  };
  /** Drive the scene's shell; everything inside is shown in the terminal window. */
  terminal<T>(fn: (t: TerminalSession) => Promise<T>): Promise<T>;
  browser: {
    /** Load `url` in a real browser and show it. */
    open(url: string, opts?: { waitFor?: RegExp }): Promise<void>;
  };
  /** Cmd-Tab to a window without doing anything in it. */
  focus(app: AppId): void;
  /** Hold on the current picture. */
  pause(seconds: number): void;
}

export interface SceneDefinition {
  title: string;
  notes?: string;
  run(s: SceneContext): Promise<void>;
}

export const defineScene = (scene: SceneDefinition): SceneDefinition => scene;
