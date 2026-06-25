import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBucketBinding, makeHelpers } from "./BucketBinding.ts";
import { BucketRead, type ReadBucketClient } from "./BucketRead.ts";
import type { R2GetOptions, R2ListOptions, R2Objects } from "./BucketTypes.ts";

/**
 * Implementation of the {@link BucketRead} service that uses a Worker binding.
 */
export const ReadBucketBinding = Layer.effect(
  BucketRead,
  Effect.suspend(() => makeBucketBinding({ makeClient: makeRead })),
);

/** Build the read half of the binding client. */
export const makeRead = ({
  raw,
  use,
  wrapR2Object,
  wrapR2ObjectOrBody,
}: ReturnType<typeof makeHelpers>): ReadBucketClient => {
  const wrapR2Objects = (objects: runtime.R2Objects): R2Objects =>
    ({
      objects: objects.objects.map(wrapR2Object),
      delimitedPrefixes: objects.delimitedPrefixes,
      ...("cursor" in objects ? { cursor: objects.cursor } : {}),
      ...("truncated" in objects ? { truncated: objects.truncated } : {}),
    }) as R2Objects;

  return {
    raw,
    head: (key: string) =>
      use((raw) => raw.head(key)).pipe(
        Effect.map((object) => (object ? wrapR2Object(object) : object)),
      ),
    get: ((key: string, options?: R2GetOptions) =>
      use((raw) => raw.get(key, options)).pipe(
        Effect.map(wrapR2ObjectOrBody),
      )) as any,
    list: (options?: R2ListOptions) =>
      use((raw) => raw.list(options)).pipe(Effect.map(wrapR2Objects)),
  };
};
