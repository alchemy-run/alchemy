import * as s3 from "@distilled.cloud/aws/s3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isStagePrefix } from "./selfhosted.ts";

export class StagePrefixError extends Data.TaggedError("StagePrefixError")<{
  readonly message: string;
}> {}

const MAX_LIST_PAGES = 1000;

/**
 * Delete one stage's objects from a shared bucket: `<instance>-<uuid>/…` and
 * nothing else. A bucket that's gone went with its platform.
 */
export const deleteStagePrefix = Effect.fn(function* (bucket: string, instance: string) {
  const listObjects = yield* s3.listObjectsV2;
  const deleteObjects = yield* s3.deleteObjects;
  let token: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = yield* listObjects({
      Bucket: bucket,
      Prefix: `${instance}-`,
      ContinuationToken: token,
    }).pipe(Effect.catchTag("NoSuchBucket", () => Effect.undefined));
    if (listed === undefined) return;
    // `<instance>-*` also matches `<instance>-42-<uuid>/`, which is another stage.
    const keys = (listed.Contents ?? [])
      .map((object) => object.Key!)
      .filter((key) => isStagePrefix(instance, key));
    if (keys.length > 0) {
      const deleted = yield* deleteObjects({
        Bucket: bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      });
      const failed = deleted.Errors ?? [];
      if (failed.length > 0) {
        return yield* new StagePrefixError({
          message: `Failed to delete ${failed.length} objects from ${bucket}, such as ${failed[0]!.Key}: ${failed[0]!.Message ?? failed[0]!.Code}. Run destroy again.`,
        });
      }
    }
    token = listed.NextContinuationToken;
    if (token === undefined) return;
  }
  return yield* new StagePrefixError({
    message: `Stopped after ${MAX_LIST_PAGES} pages deleting ${instance} from ${bucket}. Run destroy again.`,
  });
});
