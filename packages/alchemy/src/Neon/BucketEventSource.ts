import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Binding from "../Binding.ts";
import * as Namespace from "../Namespace.ts";
import { ProviderModePolicy } from "../ProviderMode.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import { Function } from "./Function.ts";
import { FunctionRequest } from "./FunctionEnvironment.ts";
import { FunctionTrigger } from "./FunctionTrigger.ts";
import {
  decodeFunctionTriggerEvent,
  type BucketEvent,
} from "./FunctionTriggerEvent.ts";

export interface BucketEventSourceProps {
  /** Unique trigger and route name. */ name: string;
  /** Byte-exact object-key prefix. */ prefix?: string;
  /** Enable future delivery. @default true */ enabled?: boolean;
}
export type BucketEventSourceService = <R = never>(
  bucket: Bucket,
  props: BucketEventSourceProps,
  handler: (event: BucketEvent) => Effect.Effect<void, unknown, R>,
) => Effect.Effect<void, never, Exclude<R, RuntimeContext | Scope>>;
/**
 * Subscribe a Neon Function to successful uploads in a same-branch bucket.
 * The trigger is independently tracked and deleted before its Function/bucket.
 * Use invocationId for application idempotency; delivery is HTTP POST.
 *
 * ### Process Uploads
 * **Example:** Register an upload handler
 * ```typescript
 * yield* Neon.BucketEventSource(uploads, { name: "Uploads", prefix: "incoming/" }, event => Effect.log(event.objectKey));
 * ```
 *
 * @binding
 */
export interface BucketEventSource extends Binding.Service<
  BucketEventSource,
  "Neon.BucketEventSource",
  BucketEventSourceService
> {
  <R = never>(
    bucket: Bucket,
    props: BucketEventSourceProps,
    handler: (event: BucketEvent) => Effect.Effect<void, unknown, R>,
  ): Effect.Effect<
    void,
    never,
    BucketEventSource | Exclude<R, RuntimeContext | Scope>
  >;
}
export const BucketEventSource = Binding.Service<BucketEventSource>(
  "Neon.BucketEventSource",
);

/**
 * Neon Function HTTP object-event dispatch and deployment wiring.
 *
 * @layer
 * @provides Neon.BucketEventSource
 */
export const BucketEventSourceBinding = Layer.effect(
  BucketEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    const Trigger = yield* FunctionTrigger;
    return Effect.fn(function* (
      bucket: Bucket,
      props: BucketEventSourceProps,
      handler: (event: BucketEvent) => Effect.Effect<void, unknown>,
    ) {
      const path = `/__alchemy/neon/bucket/${encodeURIComponent(props.name)}`;
      const triggerName = `${host.FQN}:${props.name}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const context = yield* AlchemyContext;
        const remote = yield* ProviderModePolicy;
        if (!context.dev || remote)
          yield* Namespace.push(
            host.LogicalId,
            Trigger(props.name, {
              function: host,
              type: "storage_object_created",
              name: triggerName,
              storageObjectCreated: { bucket, prefix: props.prefix },
              path,
              enabled: props.enabled,
            }),
          );
      }
      const bucketName = yield* bucket.bucketName;
      yield* host.route(
        path,
        Effect.gen(function* () {
          const event = yield* decodeFunctionTriggerEvent(
            yield* FunctionRequest,
          );
          if (
            event.trigger.type !== "storage_object_created" ||
            event.trigger.name !== triggerName ||
            !("bucket_name" in event.data) ||
            event.data.bucket_name !== (yield* bucketName) ||
            (props.prefix && !event.data.object_key.startsWith(props.prefix))
          )
            return HttpServerResponse.empty({ status: 400 });
          yield* handler({
            invocationId: event.invocation_id,
            triggerId: event.trigger.id,
            name: props.name,
            bucketName: event.data.bucket_name,
            objectKey: event.data.object_key,
          }).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }).pipe(
          Effect.catchTag("FunctionTriggerEventError", (error) =>
            Effect.succeed(HttpServerResponse.empty({ status: error.status })),
          ),
        ),
      );
    }) as BucketEventSourceService;
  }),
);
