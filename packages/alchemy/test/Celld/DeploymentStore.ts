import * as Effect from "effect/Effect";
import {
  FleetStorageError,
  type Store,
  type StoredObject,
} from "@/Celld/FleetStorage.ts";

export const makeStore = Effect.sync(() => {
  const objects = new Map<string, StoredObject>();
  const writes: string[] = [];
  const failBefore = new Set<string>();
  const loseResponse = new Set<string>();
  const race = new Map<string, () => void>();
  let sequence = 0;
  const store: Store = {
    get: (key) => Effect.sync(() => objects.get(key)),
    list: (prefix) =>
      Effect.sync(() =>
        [...objects]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, object]) => ({ key, etag: object.etag })),
      ),
    put: (key, body, condition) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          const action = race.get(key);
          race.delete(key);
          action?.();
        });
        if (yield* Effect.sync(() => failBefore.delete(key)))
          return yield* Effect.fail(
            new FleetStorageError({
              reason: "transport",
              message: "Injected uncommitted write failure.",
            }),
          );
        const old = objects.get(key);
        if (
          (condition?.ifNoneMatch && old) ||
          (condition?.ifMatch !== undefined && old?.etag !== condition.ifMatch)
        )
          return yield* Effect.fail(
            new FleetStorageError({
              reason: "conflict",
              message: "Conditional write lost.",
            }),
          );
        const result = yield* Effect.sync(() => {
          const etag = `etag-${++sequence}`;
          objects.set(key, { body: new Uint8Array(body), etag });
          writes.push(key);
          return { etag };
        });
        if (yield* Effect.sync(() => loseResponse.delete(key)))
          return yield* Effect.fail(
            new FleetStorageError({
              reason: "transport",
              message: "Injected lost committed response.",
            }),
          );
        return result;
      }),
    delete: (key, condition) =>
      Effect.gen(function* () {
        const old = objects.get(key);
        if (condition?.ifMatch !== undefined && old?.etag !== condition.ifMatch)
          return yield* Effect.fail(
            new FleetStorageError({
              reason: "conflict",
              message: "Conditional delete lost.",
            }),
          );
        yield* Effect.sync(() => {
          objects.delete(key);
        });
      }),
  };
  return { store, objects, writes, failBefore, loseResponse, race };
});
