import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
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

    const dev = hyperdrive.Props.dev;
    const hyperdrives =
      ctx.dev && dev
        ? {
            [hyperdrive.LogicalId]: {
              scheme: dev.scheme,
              host: dev.host,
              port: dev.port ?? defaultPort(dev.scheme),
              user: dev.user,
              database: dev.database,
              password: Redacted.isRedacted(dev.password)
                ? Redacted.value(dev.password)
                : dev.password,
            },
          }
        : undefined;

    yield* host.bind`${hyperdrive}`({
      bindings: [
        {
          type: "hyperdrive",
          name: hyperdrive.LogicalId,
          id: hyperdrive.hyperdriveId,
        },
      ],
      hyperdrives,
    });
  });
});
