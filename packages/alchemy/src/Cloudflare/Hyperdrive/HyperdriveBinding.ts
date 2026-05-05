import * as Effect from "effect/Effect";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Output from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker } from "../Workers/Worker.ts";
import {
  defaultPort,
  type Hyperdrive,
  type HyperdriveDevOrigin,
} from "./Hyperdrive.ts";

export const HyperdriveBinding = Effect.gen(function* () {
  const ctx = yield* AlchemyContext;

  return Effect.fn(function* (host: ResourceLike, hyperdrive: Hyperdrive) {
    if (!isWorker(host)) {
      return yield* Effect.die(
        new Error(`HyperdriveBinding does not support runtime '${host.Type}'`),
      );
    }

    const origin = Output.map(
      Output.all(hyperdrive.dev, hyperdrive.origin, hyperdrive.mtls),
      ([dev, origin, mtls]): Required<HyperdriveDevOrigin> => {
        if (dev) {
          return {
            scheme: dev.scheme,
            host: dev.host,
            port: dev.port ?? defaultPort(dev.scheme),
            user: dev.user,
            database: dev.database,
            password: dev.password,
            sslmode: dev.sslmode ?? "prefer",
          };
        }
        if ("accessClientId" in origin) {
          throw new Error(
            `Hyperdrive instance ${hyperdrive.LogicalId} has an origin that requires Cloudflare Access. This is not supported in development mode. ` +
              "Select a different origin or set the `dev` property to an origin that does not require Cloudflare Access.",
          );
        }
        return {
          scheme: origin.scheme,
          host: origin.host,
          port: origin.port ?? defaultPort(origin.scheme),
          user: origin.user,
          database: origin.database,
          password: origin.password,
          sslmode: mtls?.sslmode ?? "require",
        };
      },
    );

    yield* host.bind`${hyperdrive}`({
      bindings: [
        {
          type: "hyperdrive",
          name: hyperdrive.LogicalId,
          id: hyperdrive.hyperdriveId as unknown as string,
        },
      ],
      hyperdrives: ctx.dev
        ? (Output.map(
            Output.all(hyperdrive.hyperdriveId, Output.asOutput(origin)),
            ([id, origin]) => ({
              [id]: origin,
            }),
          ) as unknown as Record<string, Required<HyperdriveDevOrigin>>)
        : undefined,
    });
  });
});
