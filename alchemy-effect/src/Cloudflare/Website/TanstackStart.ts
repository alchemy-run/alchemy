import * as Effect from "effect/Effect";
import {
  Worker,
  type WorkerServices,
  type WorkerShape,
} from "../Workers/Worker.ts";

export const TanstackStart = <
  Shape extends Partial<WorkerShape>,
  Req extends WorkerServices = never,
>(
  id: string,
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
