import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Binding from "../../Binding.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import type { Hyperdrive } from "./Hyperdrive.ts";
import { HyperdriveBinding } from "./HyperdriveBinding.ts";

export interface HyperdriveConnectionClient {
  /**
   * The raw runtime `Hyperdrive` binding. Use this when integrating with a
   * driver that wants direct access to the Cloudflare object.
   */
  raw: Effect.Effect<runtime.Hyperdrive>;
  /**
   * A valid DB connection string for use with a driver/ORM.
   */
  connectionString: Effect.Effect<string>;
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
  password: Effect.Effect<string>;
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
export class HyperdriveConnection extends Binding.Service<
  HyperdriveConnection,
  (hyperdrive: Hyperdrive) => Effect.Effect<HyperdriveConnectionClient>
>()("Cloudflare.Hyperdrive.Connection") {}

export const HyperdriveConnectionLive = Layer.effect(
  HyperdriveConnection,
  Effect.gen(function* () {
    const Policy = yield* HyperdriveConnectionPolicy;

    return Effect.fn(function* (hyperdrive: Hyperdrive) {
      yield* Policy(hyperdrive);
      const hd = yield* Effect.serviceOption(WorkerEnvironment).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((env) => env?.[hyperdrive.LogicalId]! as runtime.Hyperdrive),
        Effect.cached,
      );

      return {
        raw: hd,
        connectionString: hd.pipe(Effect.map((hd) => hd.connectionString)),
        host: hd.pipe(Effect.map((hd) => hd.host)),
        port: hd.pipe(Effect.map((hd) => hd.port)),
        user: hd.pipe(Effect.map((hd) => hd.user)),
        password: hd.pipe(Effect.map((hd) => hd.password)),
        database: hd.pipe(Effect.map((hd) => hd.database)),
      } satisfies HyperdriveConnectionClient;
    });
  }),
);

export class HyperdriveConnectionPolicy extends Binding.Policy<
  HyperdriveConnectionPolicy,
  (hyperdrive: Hyperdrive) => Effect.Effect<void>
>()("Cloudflare.Hyperdrive.Connection") {}

export const HyperdriveConnectionPolicyLive =
  HyperdriveConnectionPolicy.layer.effect(HyperdriveBinding);
