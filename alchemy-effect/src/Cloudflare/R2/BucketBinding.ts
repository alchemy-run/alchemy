import * as Effect from "effect/Effect";
import * as Output from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker } from "../Workers/Worker.ts";
import type { Bucket } from "./Bucket.ts";

export const BucketBinding = Effect.fn(function* (
  host: ResourceLike,
  bucket: Bucket,
) {
  if (isWorker(host)) {
    yield* host.bind`Bind(${bucket})`({
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
      new Error(`BucketBinding does not support runtime '${host.Type}'`),
    );
  }
});
