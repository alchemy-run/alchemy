import * as Effect from "effect/Effect";
import * as Output from "../../Output.ts";
import * as Worker from "../Workers/Worker.ts";
import type { Bucket } from "./Bucket.ts";

export const BucketBinding = Effect.gen(function* () {
  const worker = yield* Worker.WorkerRuntime;
  return (bucket: Bucket) =>
    worker.bind({
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
});
