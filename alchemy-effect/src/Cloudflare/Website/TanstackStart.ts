import * as Effect from "effect/Effect";
import type { FunctionMain } from "../../Serverless/Function.ts";
import { Worker } from "../Workers/Worker.ts";

export const TanstackStart =
  (id: string) =>
  <Shape extends FunctionMain, Req extends Worker.Req = never>(
    eff: Effect.Effect<Shape, never, Req>,
  ) =>
    Worker(
      id,
      {
        // TODO(sam): main entrypoint should be the Tanstack Start entrypoint (that is assumed to import and run this)
        main: import.meta.path,
      },
      eff,
    );
