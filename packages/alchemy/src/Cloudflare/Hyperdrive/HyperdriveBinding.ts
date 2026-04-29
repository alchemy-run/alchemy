import * as Effect from "effect/Effect";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker } from "../Workers/Worker.ts";
import type { Hyperdrive } from "./Hyperdrive.ts";

export const HyperdriveBinding = Effect.fn(function* (
  host: ResourceLike,
  hyperdrive: Hyperdrive,
) {
  if (isWorker(host)) {
    yield* host.bind`${hyperdrive}`({
      bindings: [
        {
          type: "hyperdrive",
          name: hyperdrive.LogicalId,
          id: hyperdrive.hyperdriveId,
        },
      ],
    });
  } else {
    return yield* Effect.die(
      new Error(`HyperdriveBinding does not support runtime '${host.Type}'`),
    );
  }
});
