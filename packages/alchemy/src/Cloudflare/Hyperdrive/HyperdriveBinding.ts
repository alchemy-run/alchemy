import * as Effect from "effect/Effect";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Output from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker } from "../Workers/Worker.ts";
import { defaultPort, type Hyperdrive } from "./Hyperdrive.ts";

export const HyperdriveBinding = Effect.gen(function* () {
  const ctx = yield* AlchemyContext;

  return Effect.fn(function* (host: ResourceLike, hyperdrive: Hyperdrive) {
    if (!isWorker(host)) {
      return yield* Effect.die(
        new Error(`HyperdriveBinding does not support runtime '${host.Type}'`),
      );
    }

    yield* host.bind`${hyperdrive}`({
      bindings: [
        {
          type: "hyperdrive",
          name: hyperdrive.LogicalId,
          id: hyperdrive.hyperdriveId,
        },
      ],
      hyperdrives:
        ctx.dev && hyperdrive.Props.dev
          ? Output.map(
              Output.all(
                Output.asOutput(hyperdrive.Props.dev),
                hyperdrive.hyperdriveId,
              ),
              ([dev, id]) => ({
                [id]: {
                  scheme: dev.scheme,
                  host: dev.host,
                  port: dev.port ?? defaultPort(dev.scheme),
                  user: dev.user,
                  database: dev.database,
                  password: dev.password,
                  sslmode: dev.sslmode ?? "prefer",
                },
              }),
            )
          : undefined,
    });
  });
});
