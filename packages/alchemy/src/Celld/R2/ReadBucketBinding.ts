import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeR2BucketBinding,
  type makeR2BucketHelpers,
  validateR2Options,
} from "./BucketBinding.ts";
import type { GetOptions, NativeObjects, Objects } from "./BucketTypes.ts";
import { ReadBucket, type ReadBucketClient } from "./ReadBucket.ts";

/**
 * Native reads from a Celld fleet bucket keyspace.
 *
 * @layer
 * @provides Celld.R2.ReadBucket
 * @product R2
 */
export const ReadBucketBinding = Layer.effect(
  ReadBucket,
  Effect.suspend(() =>
    makeR2BucketBinding({ makeClient: makeReadBucketClient }),
  ),
);

/** Build the read half of the native bucket client. */
export const makeReadBucketClient = ({
  raw,
  use,
  wrapR2Object,
  wrapR2ObjectOrBody,
}: ReturnType<typeof makeR2BucketHelpers>): ReadBucketClient => {
  const wrapObjects = (page: NativeObjects): Objects => {
    const common = {
      objects: page.objects.map(wrapR2Object),
      delimitedPrefixes: page.delimitedPrefixes,
    };
    return page.truncated
      ? { ...common, truncated: true, cursor: page.cursor }
      : { ...common, truncated: false };
  };
  return {
    raw,
    head: (key) =>
      use((binding) => binding.head(key)).pipe(
        Effect.map((object) => (object === null ? null : wrapR2Object(object))),
      ),
    get: ((key: string, options?: GetOptions) =>
      use((binding) => {
        validateR2Options(options);
        return binding.get(key, options);
      }).pipe(Effect.map(wrapR2ObjectOrBody))) as ReadBucketClient["get"],
    list: (options) =>
      use((binding) => binding.list(options)).pipe(Effect.map(wrapObjects)),
  };
};
