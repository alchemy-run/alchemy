/**
 * Pi Durable on Cloudflare: conversations in a Durable Object's SQLite.
 *
 * @module
 */
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { PiError } from "../Errors.ts";
import { fromPi } from "../internal/promise.ts";
import { Storage } from "../Storage.ts";

/**
 * Keep a harness's conversations in the SQLite of the Durable Object that
 * yields it, under the harness's table prefix (`pi_` by default). The
 * harness keeps the object's alarm armed while Pi has work, so an evicted
 * object wakes up and resumes where it stopped.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * const HarnessLive = Layer.mergeAll(ModelsLive, PiCloudflare.DurableObjectStorage, Pi.NoEnv);
 * ```
 *
 * @layer
 * @provides Pi.Storage
 */
export const DurableObjectStorage: Layer.Layer<Storage> = Layer.succeed(Storage, {
  instance: Effect.map(Effect.serviceOption(DurableObjectState), (state) => ({
    evictable: true,
    open: (prefix: string) =>
      Option.isNone(state)
        ? Effect.fail(
            new PiError({
              message:
                "PiCloudflare.DurableObjectStorage is only available inside a Durable Object",
            }),
          )
        : fromPi(async () => {
            const { openDurableObjectSqliteStorage } =
              await import("@earendil-works/pi-durable/storage/sqlite/cloudflare");
            return openDurableObjectSqliteStorage(
              (state.value.raw as unknown as { storage: never }).storage,
              { prefix },
            );
          }),
  })),
});
