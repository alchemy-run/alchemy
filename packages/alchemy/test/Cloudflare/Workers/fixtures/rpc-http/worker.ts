import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
});

export default class RpcHttpTestWorker extends Cloudflare.Worker<RpcHttpTestWorker>()(
  "RpcHttpTestWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    return {
      fetch: RpcServer.toHttpEffect(PingRpcs).pipe(
        Effect.provide(
          Layer.mergeAll(handlersLayer, RpcSerialization.layerNdjson),
          // ^ ndjson is the canonical RpcServer.toHttpEffect protocol;
          //   it streams one message per line.
        ),
      ),
    };
  }),
) {}
