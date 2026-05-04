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

export const ResourceStateSchema = Schema.Any;

export class BearerTokenValidator extends Context.Service<
  BearerTokenValidator,
  {
    readonly validate: (
      token: string,
    ) => Effect.Effect<void, HttpApiError.Unauthorized>;
  }
>()("alchemy/State/BearerTokenValidator") {}

export class StateAuth extends HttpApiMiddleware.Service<
  StateAuth,
  { requires: BearerTokenValidator }
>()("alchemy/State/StateAuth", {
  security: {
    bearer: HttpApiSecurity.bearer,
  },
  error: HttpApiError.UnauthorizedNoContent,
}) {}

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

export const ListStacks = HttpApiEndpoint.get("listStacks", "/state/stacks", {
  success: Schema.Array(Schema.String),
});

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

/** Response shape for the unauthenticated `/version` probe. */
export const VersionResponse = Schema.Struct({
  version: Schema.Number,
});

/**
 * Unauthenticated probe so clients can detect a stale (or absent)
 * deployed worker without holding a valid bearer token. The returned
 * version is bumped whenever the wire / behavioural contract changes
 * in a way that requires a redeploy.
 */
export const GetVersion = HttpApiEndpoint.get("getVersion", "/version", {
  success: VersionResponse,
});

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

export class VersionGroup extends HttpApiGroup.make("version").add(
  GetVersion,
) {}

export class StateApi extends HttpApi.make("alchemy-state")
  .add(StateGroup)
  .add(VersionGroup) {}
