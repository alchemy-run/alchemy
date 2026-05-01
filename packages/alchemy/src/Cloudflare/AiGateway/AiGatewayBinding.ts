/// <reference types="@cloudflare/workers-types" />

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { AiGateway as AiGatewayResource } from "./AiGateway.ts";

export class AiGatewayError extends Data.TaggedError("AiGatewayError")<{
  message: string;
  cause: unknown;
}> {}

export interface AiGatewayClient {
  /**
   * Effect resolving to the raw Workers AI binding.
   */
  raw: Effect.Effect<Ai, never, WorkerEnvironment>;
  /**
   * Effect resolving to the raw AI Gateway runtime binding.
   */
  gateway: Effect.Effect<AiGateway, never, WorkerEnvironment>;
  patchLog(
    logId: string,
    data: Parameters<AiGateway["patchLog"]>[1],
  ): Effect.Effect<void, AiGatewayError, WorkerEnvironment>;
  getLog(
    logId: string,
  ): Effect.Effect<AiGatewayLog, AiGatewayError, WorkerEnvironment>;
  getUrl(
    provider?: Parameters<AiGateway["getUrl"]>[0],
  ): Effect.Effect<string, AiGatewayError, WorkerEnvironment>;
  run(
    data: Parameters<AiGateway["run"]>[0],
    options?: Parameters<AiGateway["run"]>[1],
  ): Effect.Effect<Response, AiGatewayError, WorkerEnvironment>;
}

export class AiGatewayBinding extends Binding.Service<
  AiGatewayBinding,
  (gateway: AiGatewayResource) => Effect.Effect<AiGatewayClient>
>()("Cloudflare.AiGateway.Binding") {}

export const AiGatewayBindingLive = Layer.effect(
  AiGatewayBinding,
  Effect.gen(function* () {
    const Policy = yield* AiGatewayBindingPolicy;

    return Effect.fn(function* (gateway: AiGatewayResource) {
      yield* Policy(gateway);
      const gatewayIdAccessor = yield* gateway.gatewayId;
      const gatewayId = yield* gatewayIdAccessor;
      const ai = yield* Effect.serviceOption(WorkerEnvironment).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((env) => env?.[gateway.LogicalId]! as Ai),
        Effect.cached,
      );
      const runtimeGateway = yield* ai.pipe(
        Effect.map((ai) => ai.gateway(gatewayId)),
        Effect.cached,
      );

      const use = <T>(
        fn: (gateway: AiGateway) => Promise<T>,
      ): Effect.Effect<T, AiGatewayError, WorkerEnvironment> =>
        runtimeGateway.pipe(
          Effect.flatMap((gateway) => tryPromise(() => fn(gateway))),
        );

      return {
        raw: ai,
        gateway: runtimeGateway,
        patchLog: (logId, data) =>
          use((gateway) => gateway.patchLog(logId, data)),
        getLog: (logId) => use((gateway) => gateway.getLog(logId)),
        getUrl: (provider) => use((gateway) => gateway.getUrl(provider)),
        run: (data, options) => use((gateway) => gateway.run(data, options)),
      } satisfies AiGatewayClient;
    });
  }),
);

export class AiGatewayBindingPolicy extends Binding.Policy<
  AiGatewayBindingPolicy,
  (gateway: AiGatewayResource) => Effect.Effect<void>
>()("Cloudflare.AiGateway.Binding") {}

export const AiGatewayBindingPolicyLive = AiGatewayBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, gateway: AiGatewayResource) {
    if (isWorker(host)) {
      yield* host.bind(gateway.LogicalId, {
        bindings: [
          {
            type: "ai",
            name: gateway.LogicalId,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`AiGatewayBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);

const tryPromise = <T>(
  fn: () => Promise<T>,
): Effect.Effect<T, AiGatewayError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new AiGatewayError({
        message:
          error instanceof Error
            ? error.message
            : "Unknown AI Gateway runtime error",
        cause: error,
      }),
  });
