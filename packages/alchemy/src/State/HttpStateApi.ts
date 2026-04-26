import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

/**
 * Abstract bearer-token validator. The schema knows that every
 * authenticated endpoint needs *some* implementation of this service;
 * concrete implementations (e.g. the Cloudflare worker, an in-memory
 * test stub) live with their respective backends and are wired in via
 * `Layer.provide`.
 *
 * `validate` resolves successfully when the presented token is valid
 * and fails with `HttpApiError.Unauthorized` otherwise. Implementations
 * are responsible for any caching, timing-safe comparison, and
 * platform-specific lookups (e.g. `WorkerEnvironment` reads).
 */
export class BearerTokenValidator extends Context.Service<
  BearerTokenValidator,
  {
    readonly validate: (
      token: string,
    ) => Effect.Effect<void, HttpApiError.Unauthorized>;
  }
>()("alchemy/State/BearerTokenValidator") {}

/**
 * Bearer-token security middleware. Applied to {@link StateGroup}, so
 * every endpoint in the API:
 *
 * - declares `HttpApiError.Unauthorized` as a failure mode (typed on
 *   the derived client and documented in OpenAPI),
 * - has its handler effect wrapped at request time by an authentication
 *   check delegated to the {@link BearerTokenValidator} service.
 */
export class StateAuth extends HttpApiMiddleware.Service<
  StateAuth,
  { requires: BearerTokenValidator }
>()("alchemy/State/StateAuth", {
  security: {
    bearer: HttpApiSecurity.bearer,
  },
  // `NoContent` variant: the wire response is just the 401 status
  // with an empty body — no JSON envelope. The client decoder produces
  // a typed `new HttpApiError.Unauthorized({})` from the status alone,
  // matching Effect's built-in convention.
  error: HttpApiError.UnauthorizedNoContent,
}) {}

/**
 * Generic implementation of {@link StateAuth} that delegates the
 * actual token comparison to the {@link BearerTokenValidator} service.
 * Backend-specific Layers (Cloudflare, in-memory, …) provide
 * `BearerTokenValidator`; this Layer is the same on every backend.
 */
export const StateAuthLive: Layer.Layer<
  StateAuth,
  never,
  BearerTokenValidator
> = Layer.effect(
  StateAuth,
  Effect.gen(function* () {
    const validator = yield* BearerTokenValidator;
    return {
      bearer: (httpEffect, { credential }) =>
        validator
          .validate(Redacted.value(credential))
          .pipe(Effect.flatMap(() => httpEffect)),
    };
  }),
);

/**
 * Schema for a {@link ResourceState} value at the wire level.
 *
 * The state store is intentionally agnostic of the inner shape:
 * resources are persisted as opaque JSON blobs and the schema only
 * asserts they're objects with a `status` discriminator. Higher-level
 * concerns like `Redacted<T>` round-tripping live in the consumer
 * (see {@link HttpStateStore} which wraps the client).
 */
export const ResourceStateSchema = Schema.Any;

/** `stack` path segment for nested REST resources. */
const StackParams = Schema.Struct({
  stack: Schema.String,
});

/** Optional stage selector for stack deletion. */
const OptionalStageQuery = Schema.Struct({
  stage: Schema.optional(Schema.String),
});

/** `(stack, stage)` path segments shared by stage-scoped endpoints. */
const StackStage = Schema.Struct({
  stack: Schema.String,
  stage: Schema.String,
});

/** `(stack, stage, fqn)` path segments for a single resource. */
const ResourceKey = Schema.Struct({
  stack: Schema.String,
  stage: Schema.String,
  fqn: Schema.String,
});

export const ListStacks = HttpApiEndpoint.get(
  "listStacks",
  "/state/stacks",
  { success: Schema.Array(Schema.String) },
);

export const ListStages = HttpApiEndpoint.get(
  "listStages",
  "/state/stacks/:stack/stages",
  {
    params: StackParams,
    success: Schema.Array(Schema.String),
  },
);

export const ListResources = HttpApiEndpoint.get(
  "listResources",
  "/state/stacks/:stack/stages/:stage/resources",
  {
    params: StackStage,
    success: Schema.Array(Schema.String),
  },
);

export const GetState = HttpApiEndpoint.get(
  "getState",
  "/state/stacks/:stack/stages/:stage/resources/:fqn",
  {
    params: ResourceKey,
    success: Schema.UndefinedOr(ResourceStateSchema),
  },
);

export const SetState = HttpApiEndpoint.put(
  "setState",
  "/state/stacks/:stack/stages/:stage/resources/:fqn",
  {
    params: ResourceKey,
    payload: ResourceStateSchema,
    success: ResourceStateSchema,
  },
);

export const DeleteState = HttpApiEndpoint.delete(
  "deleteState",
  "/state/stacks/:stack/stages/:stage/resources/:fqn",
  {
    params: ResourceKey,
    success: HttpApiSchema.NoContent,
  },
);

export const DeleteStack = HttpApiEndpoint.delete(
  "deleteStack",
  "/state/stacks/:stack",
  {
    params: StackParams,
    query: OptionalStageQuery,
    success: HttpApiSchema.NoContent,
  },
);

export const GetReplacedResources = HttpApiEndpoint.get(
  "getReplacedResources",
  "/state/stacks/:stack/stages/:stage/replaced-resources",
  {
    params: StackStage,
    success: Schema.Array(ResourceStateSchema),
  },
);

export class StateGroup extends HttpApiGroup.make("state")
  .add(ListStacks)
  .add(ListStages)
  .add(ListResources)
  .add(GetState)
  .add(SetState)
  .add(DeleteState)
  .add(GetReplacedResources)
  .add(DeleteStack)
  .middleware(StateAuth) {}

export class StateApi extends HttpApi.make("alchemy-state").add(StateGroup) {}
