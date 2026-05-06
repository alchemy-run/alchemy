import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Hyperdrive } from "./Hyperdrive.ts";
import { defaultPort, type HyperdriveDevOrigin } from "./Hyperdrive.ts";

export interface HyperdriveBindingClient {
  /**
   * The raw runtime `Hyperdrive` binding. Use this when integrating with a
   * driver that wants direct access to the Cloudflare object.
   */
  raw: Effect.Effect<runtime.Hyperdrive>;
  /**
   * A valid DB connection string for use with a driver/ORM.
   */
  connectionString: Effect.Effect<Redacted.Redacted<string>>;
  /**
   * Hostname valid only within the current Worker invocation.
   */
  host: Effect.Effect<string>;
  /**
   * Port to pair with `host`.
   */
  port: Effect.Effect<number>;
  /**
   * Database user.
   */
  user: Effect.Effect<string>;
  /**
   * Randomly generated password valid only within the current Worker
   * invocation.
   */
  password: Effect.Effect<Redacted.Redacted<string>>;
  /**
   * Database name.
   */
  database: Effect.Effect<string>;
}

/**
 * A typed accessor for a Cloudflare Hyperdrive runtime binding inside a
 * Worker. Provides the same shape as the raw `Hyperdrive` runtime object
 * (connection string, host, port, user, password, database) plus a `raw`
 * escape hatch for libraries that want direct access.
 *
 * @example Bind Hyperdrive in a Worker
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.bind(MyHyperdrive);
 * const url = yield* hd.connectionString;
 * ```
 *
 * @binding
 */
export class HyperdriveBinding extends Binding.Service<
  HyperdriveBinding,
  (hyperdrive: Hyperdrive) => Effect.Effect<HyperdriveBindingClient>
>()("Cloudflare.Hyperdrive.Binding") {}

export const HyperdriveBindingLive = Layer.effect(
  HyperdriveBinding,
  Effect.gen(function* () {
    const Policy = yield* HyperdriveBindingPolicy;

    return Effect.fn(function* (hyperdrive: Hyperdrive) {
      yield* Policy(hyperdrive);
      const hd = yield* Effect.serviceOption(WorkerEnvironment).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((env) => env?.[hyperdrive.LogicalId]! as runtime.Hyperdrive),
        Effect.cached,
      );

      return {
        raw: hd,
        connectionString: hd.pipe(
          Effect.map((hd) => Redacted.make(hd.connectionString)),
        ),
        host: hd.pipe(Effect.map((hd) => hd.host)),
        port: hd.pipe(Effect.map((hd) => hd.port)),
        user: hd.pipe(Effect.map((hd) => hd.user)),
        password: hd.pipe(Effect.map((hd) => Redacted.make(hd.password))),
        database: hd.pipe(Effect.map((hd) => hd.database)),
      } satisfies HyperdriveBindingClient;
    });
  }),
);

export class HyperdriveBindingPolicy extends Binding.Policy<
  HyperdriveBindingPolicy,
  (hyperdrive: Hyperdrive) => Effect.Effect<void>
>()("Cloudflare.Hyperdrive.Binding") {}

export const HyperdriveBindingPolicyLive = HyperdriveBindingPolicy.layer.effect(
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;

    return Effect.fn(function* (host: ResourceLike, hyperdrive: Hyperdrive) {
      if (!isWorker(host)) {
        return yield* Effect.die(
          new Error(
            `HyperdriveBinding does not support runtime '${host.Type}'`,
          ),
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
  }),
);
