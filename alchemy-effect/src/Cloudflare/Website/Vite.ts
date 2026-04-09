import type { MemoOptions } from "../../Build/Memo.ts";
import { Worker, type WorkerProps } from "../Workers/Worker.ts";

export interface ViteProps extends Omit<WorkerProps, "vite" | "main"> {
  /**
   * Working directory for the Vite website.
   * Defaults to the current working directory.
   */
  cwd?: string;
  /**
   * Options for memoizing the build input.
   * Defaults to all files in the working directory that are not git ignored, plus the package manager lockfile.
   */
  memo?: MemoOptions;
}

export const Vite = (id: string, props: ViteProps = {}) =>
  Worker(id, {
    ...props,
    main: undefined!,
    vite: {
      cwd: props.cwd,
      memo: props.memo,
    },
  });
