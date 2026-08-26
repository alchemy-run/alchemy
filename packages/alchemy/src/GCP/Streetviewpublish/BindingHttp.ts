import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Photo } from "./Photo.ts";
import type { PhotoSequence } from "./PhotoSequence.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Street View photo bindings.
 * NOT exported from index.ts.
 */
export const makePhotoHttpBinding = <
  I extends { photoId: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (photo: Photo) {
      const photoId = yield* photo.photoId;
      return Effect.fn(`${options.tag}(${photo.LogicalId})`)(function* (
        request: Omit<I, "photoId">,
      ) {
        return yield* run({
          ...request,
          photoId: yield* photoId,
        } as I);
      });
    });
  });

/**
 * Shared HTTP scaffolding for Street View photo sequence bindings.
 * NOT exported from index.ts.
 */
export const makePhotoSequenceHttpBinding = <
  I extends { sequenceId: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (sequence: PhotoSequence) {
      const sequenceId = yield* sequence.sequenceId;
      return Effect.fn(`${options.tag}(${sequence.LogicalId})`)(function* (
        request: Omit<I, "sequenceId">,
      ) {
        return yield* run({
          ...request,
          sequenceId: yield* sequenceId,
        } as I);
      });
    });
  });
