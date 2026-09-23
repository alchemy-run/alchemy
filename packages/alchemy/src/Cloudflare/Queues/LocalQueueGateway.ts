import { Queue } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { open } from "@alchemy.run/cloudflare-runtime/core/platform-proxy";
import { Registry } from "@alchemy.run/cloudflare-runtime/core/registry";
import * as Schedule from "effect/Schedule";
import type * as runtime from "@cloudflare/workers-types";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { gatewayName, localGatewayRuntime } from "../LocalGateway.ts";
import type { makeQueueHelpers } from "./QueueBinding.ts";
import { SendError } from "./QueueTypes.ts";

/** Producer gateway into the same dev-registry broker used by local Workers. */
export const makeProxyQueueHelpers = (
  name: string,
  ambient: Context.Context<never>,
): ReturnType<typeof makeQueueHelpers> => {
  const tryPromise = <T>(fn: () => Promise<T>) =>
    Effect.tryPromise({
      try: fn,
      catch: (cause) =>
        new SendError({
          message:
            cause instanceof Error ? cause.message : "Local queue send failed",
          cause,
        }),
    });
  const use = <T>(fn: (queue: runtime.Queue<unknown>) => Promise<T>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        // An Action can run while its consumer Worker is still starting. Never
        // send into the runtime's accept-and-drop path before it registers.
        const targets = yield* registry
          .read([{ kind: "queue-consumer", queueName: name }])
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("200 millis"),
              times: 10,
              until: (targets) =>
                targets[`queue-consumer:${name}`] !== undefined,
            }),
          );
        if (!targets[`queue-consumer:${name}`])
          return yield* new SendError({
            message: `No local consumer is running for queue '${name}'. Start a consumer before sending messages from an Action.`,
          });
        const proxy = yield* open({
          name: gatewayName("alchemy-queue-gateway", name),
          bindings: [Queue.local({ binding: "QUEUE", queueName: name })],
        });
        return yield* tryPromise(() =>
          fn(proxy.env.QUEUE as runtime.Queue<unknown>),
        );
      }),
    ).pipe(
      Effect.provide(localGatewayRuntime),
      Effect.provideContext(ambient),
    ) as Effect.Effect<T, SendError>;
  return {
    raw: Effect.die(
      new SendError({
        message:
          "A local queue has no long-lived native binding outside a Worker; use send/sendBatch.",
      }),
    ),
    use,
    tryPromise,
  };
};
