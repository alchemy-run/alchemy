import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { PingRpcs } from "./group.ts";

let counter = 0;

const handlersLayer = PingRpcs.toLayer({
  Ping: ({ message }) =>
    Effect.sync(() => ({
      echo: message,
      n: ++counter,
    })),
  Slow: ({ ms }) => Effect.sleep(`${ms} millis`).pipe(Effect.as({ slept: ms })),
  Count: ({ upto }) =>
    Stream.fromReadableStream<number, never>({
      evaluate: () => {
        let next = 1;
        return new ReadableStream<number>({
          pull(controller) {
            if (next > upto) {
              controller.close();
              return;
            }
            controller.enqueue(next++);
          },
        });
      },
      onError: (cause) => cause as never,
    }),
});

export default class RpcHttpTestWorker extends Cloudflare.Worker<RpcHttpTestWorker>()(
  "RpcHttpTestWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    return {
      fetch: RpcServer.toHttpEffect(PingRpcs).pipe(
        Effect.provide(
          Layer.mergeAll(handlersLayer, RpcSerialization.layerNdjson),
        ),
      ) as unknown as HttpEffect,
    };
  }),
) {}
