/**
 * OpenCode on Cloudflare: OpenCode itself, in a Durable Object.
 *
 * @module
 */
import { DurableObjectCallbacks } from "@alchemy.run/cloudflare/Workers/AlarmCallback";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { OpenCodeError } from "../Errors.ts";
import { Storage, type HostOptions } from "../Storage.ts";

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String(cause.message)
    : String(cause);

/**
 * Run OpenCode in the Durable Object that yields the harness, with its
 * sessions in the object's SQLite (tables prefixed `opencode_`). The
 * harness keeps the object's alarm armed while a prompt runs, so an evicted
 * object wakes up and the prompt resumes where it stopped.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * const HarnessLive = Layer.mergeAll(ModelsLive, OpenCodeCloudflare.DurableObjectStorage);
 * ```
 *
 * @layer
 * @provides OpenCode.Storage
 */
export const DurableObjectStorage: Layer.Layer<Storage> = Layer.succeed(Storage, {
  instance: Effect.map(Effect.serviceOption(DurableObjectState), (state) => ({
    // At plan time the state is a stand-in with no id, and nothing starts OpenCode.
    id: Option.match(state, { onNone: () => "", onSome: (state) => state.id?.toString() ?? "" }),
    evictable: true,
    ...(Option.isSome(state)
      ? {
          callbacks: DurableObjectCallbacks.pipe(
            Layer.provide(Layer.succeed(DurableObjectState, state.value)),
          ),
        }
      : {}),
    open: (options: HostOptions) =>
      Option.isNone(state)
        ? Effect.fail(
            new OpenCodeError({
              message:
                "OpenCodeCloudflare.DurableObjectStorage is only available inside a Durable Object",
            }),
          )
        : Effect.tryPromise({
            // Imported where it runs: this module is also loaded at plan
            // time, where OpenCode's Workers build does not resolve.
            try: async () => {
              const { OpenCodeWorkerd } = await import("@opencode/sdk/workerd");
              return OpenCodeWorkerd.create({
                ...options,
                storage: (state.value.raw as unknown as { storage: never }).storage,
              });
            },
            catch: (cause) => new OpenCodeError({ message: messageOf(cause), cause }),
          }),
  })),
});
