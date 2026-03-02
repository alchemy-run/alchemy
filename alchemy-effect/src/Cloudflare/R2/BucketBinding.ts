import * as Effect from "effect/Effect";
import type { ExecutionContext } from "../../Executable.ts";
import * as Output from "../../Output.ts";
import { isWorker } from "../Workers/Worker.ts";
import type { Bucket } from "./Bucket.ts";

export const BucketBinding = Effect.fn(function* (
  worker: ExecutionContext["Service"],
  bucket: Bucket,
) {
  if (isWorker(worker)) {
    yield* worker.bind({
      bindings: [
        {
          type: "r2_bucket",
          name: bucket.LogicalId,
          bucket_name: bucket.bucketName,
          jurisdiction: bucket.jurisdiction.pipe(
            Output.map((jurisdiction) =>
              jurisdiction === "default" ? undefined : jurisdiction,
            ),
          ),
        },
      ],
    });
  } else {
    return yield* Effect.die(
      new Error(`BucketBinding does not support runtime '${worker.type}'`),
    );
  }
});
