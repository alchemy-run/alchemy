import * as Effect from "effect/Effect";
import { Worker } from "../Workers/Worker.ts";

export const TanstackStart: typeof Worker = ((...args: any[]) =>
  args.length === 0
    ? (...args: [string, Effect.Effect<any>]) => TanstackStart(...args)
    : Worker(
        args[0],
        {
          // TODO(sam): main entrypoint should be the Tanstack Start entrypoint (that is assumed to import and run this)
          main: import.meta.filename,
        },
        args[1],
      )) as any;
