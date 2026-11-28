import type { DurableObjectNamespace } from "@alchemy.run/rivet/DurableObject";
import {
  DurableObjectState,
  type DurableObjectStorage,
} from "@alchemy.run/rivet/DurableObjectState";
import { layerObjectHost, type ObjectHostOptions } from "@alchemy.run/rivet/ObjectHost";
import type { Providers } from "@alchemy.run/rivet/Providers";
import type { HttpEffect } from "alchemy/Http";
import { makeDurableObjectEngine } from "alchemy/Workers/DurableObjectEngine";
import { ObjectHost } from "alchemy/Workers/ObjectHost";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import type { WorkflowEngine } from "effect/workflow";
/**
 * Host a domain model (`@alchemy.run/domain`) on Rivet Durable Objects.
 *
 * @module
 */
import {
  type Attachment,
  className,
  type Host,
  makePlatform,
  type Namespace,
  type ObjectImpl,
  type Retention,
  runtimeClaim,
  SUBSCRIPTION_HEADER,
} from "../DurableObjects.ts";
import type { Platform, Subscription } from "../Platform.ts";

export type { Retention } from "../DurableObjects.ts";

/** The SQL storage the workflow engine journals each saga run in. */
interface EngineStateShape {
  readonly storage: {
    readonly sql: {
      exec<T extends Record<string, unknown>>(
        query: string,
        ...bindings: ReadonlyArray<unknown>
      ): Effect.Effect<{ toArray(): Effect.Effect<T[]> }>;
    };
    readonly transaction: DurableObjectStorage["transaction"];
  };
}

/** A run's instance state, as the workflow engine reads it. */
class EngineState extends Context.Service<EngineState, EngineStateShape>()(
  "Rivet/Domain/EngineState",
) {}

/**
 * The engine's SQL over a Rivet instance's database: its schema arrives as
 * one script, and RivetKit runs one statement per call.
 */
const engineState = (state: DurableObjectState["Service"]): EngineStateShape => ({
  storage: {
    sql: {
      exec: <T extends Record<string, unknown>>(
        query: string,
        ...bindings: ReadonlyArray<unknown>
      ) => {
        const statements = query
          .split(";")
          .map((statement) => statement.trim())
          .filter((statement) => statement.length > 0);
        if (statements.length <= 1) return state.storage.sql.exec<T>(query, ...bindings);
        return Effect.forEach(statements, (statement) => state.storage.sql.exec<T>(statement)).pipe(
          Effect.map((cursors) => cursors[cursors.length - 1]!),
        );
      },
    },
    transaction: (effect, options) => state.storage.transaction(effect, options),
  },
});

/**
 * Forward a live read's WebSocket upgrade (the current request) to the
 * instance that owns `key`, carrying the subscription. The caller sets the
 * header, overwriting any a client sent, so the instance can trust it.
 */
const connectTo = (namespace: Namespace, key: string, subscription: Subscription): HttpEffect =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- erases RuntimeContext, which the caller's runtime provides at call time
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const forwarded = request.modify({
      headers: Headers.set(
        request.headers,
        SUBSCRIPTION_HEADER,
        JSON.stringify({ key, subscription } satisfies Attachment),
      ),
    });
    const stub = namespace.getByName(key) as unknown as ReturnType<
      DurableObjectNamespace<{}>["getByName"]
    >;
    return yield* stub.fetch(forwarded).pipe(Effect.orDie);
  }) as HttpEffect;

/** Options for {@link layerDurableObjects}. */
export interface DurableObjectsOptions<PoolReq> extends ObjectHostOptions<PoolReq> {
  /**
   * How long each actor keeps the rows that only dedupe needs: command and
   * decision receipts, policy delivery marks, and cancelled scheduled
   * commands. An actor deletes a few rows past their window each time it
   * commits, so an instance stops growing with its traffic. `"forever"`
   * keeps a kind of row.
   *
   * @default { receipts: "30 days", deliveries: "7 days", cancelled: "7 days" }
   */
  readonly retention?: Retention;
}

/**
 * Host a domain model on Rivet Durable Objects. Provide it to the model's
 * Layer, as `Domain.InMemory` or `DomainCloudflare.layerDurableObjects()` would be, in
 * every runtime that serves the model: a Worker, a Lambda, a container.
 *
 * The model's aggregate instances, view keys, policies and saga runs are
 * instances of one Durable Object class, `name`, each named after what it
 * holds (`Bank.AccountAggregate/a-1`). Built in a caller, the Layer deploys
 * that class to `pool` and reaches it through the control plane's gateway.
 * The pool's nodes load the model's Layer from `main`, and there the same
 * Layer hosts the class.
 *
 * Commands to one aggregate instance run one at a time. Events, state and
 * the outbox commit together in the instance's SQLite, and deliveries to
 * views, projections and policies are at least once and in order per source.
 * Scheduled commands and retries are the instance's alarm. Over
 * `Domain.protocolWebSocket`, a live read's WebSocket travels through the
 * control plane's gateway to the instance that owns the key, which pushes
 * every commit down it. Over `Domain.protocolHttp`, live reads are streamed
 * responses that poll the owning instance.
 *
 * ### Hosting a model on Rivet
 * **Example:** The model's Layer, served from a Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as RivetDocker from "@alchemy.run/rivet/Docker";
 * import * as DomainRivet from "@alchemy.run/domain/Rivet";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 * import { CustomerApi } from "./CustomerApi.api.ts";
 *
 * const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");
 * const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(ControlPlane));
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(
 *     DomainRivet.layerDurableObjects("Bank", {
 *       main: import.meta.url,
 *       handler: "BankLive",
 *       pool: Default,
 *     }),
 *   ),
 * );
 *
 * export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
 *   "BankWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* CustomerApi;
 *     return { fetch: api.fetch };
 *   }).pipe(Effect.provide(BankLive)),
 * ) {}
 * ```
 *
 * ### Keeping dedupe rows for a while
 * Receipts, policy delivery marks and cancelled scheduled commands exist only
 * to drop repeats. Each actor deletes a few that are past their window every
 * time it commits.
 *
 * **Example:** Receipts for a year, delivery marks forever
 * ```typescript
 * import * as RivetDocker from "@alchemy.run/rivet/Docker";
 * import * as DomainRivet from "@alchemy.run/domain/Rivet";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 *
 * const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");
 * const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(ControlPlane));
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(
 *     DomainRivet.layerDurableObjects("Bank", {
 *       main: import.meta.url,
 *       handler: "BankLive",
 *       pool: Default,
 *       retention: { receipts: "365 days", deliveries: "forever" },
 *     }),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const layerDurableObjects = <PoolReq>(
  /** The Rivet Durable Object class that hosts the model: its actors' name. */
  name: string,
  options: DurableObjectsOptions<PoolReq>,
): Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom,
  never,
  PoolReq | Providers
> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- built on the object host, which is provided below
  Layer.unwrap(
    Effect.gen(function* () {
      const objects = yield* ObjectHost;
      const host: Host = {
        // A model's classes are its own: `Bank.AccountAggregate`.
        declare: ({ modelName }, cls, impl) => objects.declare(className(modelName, cls), impl),
        lookup: ({ modelName }, cls) => objects.lookup?.(className(modelName, cls)),
        connect: connectTo,
        claimKey: runtimeClaim(name),
      };
      // Sagas run on the workflow engine over the same class: each execution
      // is the instance `<Workflow>/<executionId>`, its journal in that
      // instance's SQLite.
      const engine = makeDurableObjectEngine({
        declare: (cls, impl) =>
          objects.declare(
            cls,
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- an instance runs with its Rivet state, which the engine's state is read from
            Effect.flatten(impl).pipe(
              Effect.provideServiceEffect(EngineState, Effect.map(DurableObjectState, engineState)),
            ) as ObjectImpl,
          ) as never,
        // The engine reads only `toArray` from its cursors, which Rivet's have.
        state: EngineState as never,
      });
      return Layer.merge(makePlatform(host, { retention: options.retention ?? {} }), engine).pipe(
        // The model's Layer needs it too.
        Layer.provideMerge(SecureRandom.layerWebCrypto),
      );
    }),
  ).pipe(Layer.provide(layerObjectHost(name, options))) as Layer.Layer<
    Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom,
    never,
    PoolReq | Providers
  >;
