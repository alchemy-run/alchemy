import * as Effect from "effect/Effect";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker } from "../Workers/Worker.ts";
import type { Database } from "./Database.ts";

export const DatabaseBinding = Effect.fn(function* (
  host: ResourceLike,
  database: Database,
) {
  if (isWorker(host)) {
    yield* host.bind`Bind(${database})`({
      bindings: [
        {
          type: "d1",
          name: database.LogicalId,
          id: database.databaseId,
        },
      ],
    });
  } else {
    return yield* Effect.die(
      new Error(`DatabaseBinding does not support runtime '${host.Type}'`),
    );
  }
});
