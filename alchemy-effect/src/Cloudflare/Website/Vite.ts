import type { MemoOptions } from "../../Build/Memo.ts";
import { Worker, type WorkerProps } from "../Workers/Worker.ts";

export interface ViteProps extends Omit<WorkerProps, "vite" | "main"> {
  cwd?: string;
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
