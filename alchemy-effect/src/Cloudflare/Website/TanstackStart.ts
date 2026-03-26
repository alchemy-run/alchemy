import * as Effect from "effect/Effect";
import type { PlatformMain } from "../../Platform.ts";
import { Worker } from "../Workers/Worker.ts";

export const TanstackStart =
  (id: string) =>
  <Shape extends PlatformMain, Req extends Worker.Services = never>(
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
