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
 * Resource-state payload shape on the wire.
 *
 * Pinned to JSON encoding via {@link HttpApiSchema.asJson} so that both
 * sides of the API agree on `Content-Type: application/json`. With a
 * bare `Schema.Any` the server's payload-decoder map is keyed off the
 * default content type only — any client request that arrives with a
 * differently-shaped body (or a transport that drops the
 * `Content-Type` header entirely) falls into the `payloadBy.get(
 * contentType)` miss branch in `HttpApiBuilder.decodePayload` and
 * surfaces as a confusing `415 Unsupported Media Type`. Annotating
 * the schema makes the encoding explicit on both endpoints and the
 * client encoder, so the wire format is unambiguous.
 */
export const ResourceStateSchema = Schema.Any.pipe(HttpApiSchema.asJson());

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

/**
 * Optional fencing token on head-state writes — the deployment version
 * whose lease authorizes the write (see `StateWriteFence` in State.ts).
 * Travels as a query param because the write payloads are the raw
 * state values themselves.
 */
const FenceQuery = Schema.Struct({
  fence: Schema.optional(Schema.Number),
});

/**
 * A fenced head-state write lost its lease: a deployment newer than
 * `fence` has been begun. 412 Precondition Failed — decoded by the
 * client into the `fencedWriteRejected` StateStoreError. Never
 * retryable: the writer's lease is gone for good.
 */
export const StateWriteFencedWire = Schema.TaggedStruct("StateWriteFenced", {
  stack: Schema.String,
  stage: Schema.String,
  fence: Schema.Number,
}).pipe(HttpApiSchema.status(412));

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
    query: FenceQuery,
    payload: ResourceStateSchema,
    success: ResourceStateSchema,
    error: StateWriteFencedWire,
  },
);

export const DeleteState = HttpApiEndpoint.delete(
  "deleteState",
  "/state/stacks/:stack/stages/:stage/resources/:fqn",
  {
    params: ResourceKey,
    query: FenceQuery,
    success: HttpApiSchema.NoContent,
    error: StateWriteFencedWire,
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

export const GetStackOutput = HttpApiEndpoint.get(
  "getStackOutput",
  "/state/stacks/:stack/stages/:stage/output",
  {
    params: StackStage,
    success: Schema.UndefinedOr(ResourceStateSchema),
  },
);

export const SetStackOutput = HttpApiEndpoint.put(
  "setStackOutput",
  "/state/stacks/:stack/stages/:stage/output",
  {
    params: StackStage,
    query: FenceQuery,
    payload: ResourceStateSchema,
    success: ResourceStateSchema,
    error: StateWriteFencedWire,
  },
);

// ---------------------------------------------------------------------------
// Deployment history (DeploymentStore) wire contract
// ---------------------------------------------------------------------------

/** Wire shape of {@link DeploymentMeta}. */
export const DeploymentMetaWire = Schema.Struct({
  command: Schema.Literals(["deploy", "destroy"]),
  initiator: Schema.optional(
    Schema.Struct({
      user: Schema.optional(Schema.String),
      host: Schema.optional(Schema.String),
      pid: Schema.optional(Schema.Number),
    }),
  ),
  alchemyVersion: Schema.optional(Schema.String),
  gitCommit: Schema.optional(Schema.String),
});

/** Wire shape of {@link DeploymentSummary}. */
export const DeploymentSummaryWire = Schema.Struct({
  counts: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  error: Schema.optional(Schema.String),
});

/**
 * Wire shape of {@link DeploymentRecord}. Deliberately excludes the bearer
 * token: records returned by list/get/read (and the `holder` carried by
 * `DeploymentInProgress`) must never expose another deploy's capability.
 */
export const DeploymentRecordWire = Schema.Struct({
  stack: Schema.String,
  stage: Schema.String,
  version: Schema.Number,
  meta: DeploymentMetaWire,
  startedAt: Schema.Number,
  heartbeatAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  outcome: Schema.optional(
    Schema.Literals([
      "succeeded",
      "failed",
      "interrupted",
      "abandoned",
      "completed-late",
    ]),
  ),
  summary: Schema.optional(DeploymentSummaryWire),
});

/** Wire shape of {@link DeploymentEvent} — the payload travels verbatim. */
export const DeploymentEventWire = Schema.Struct({
  seq: Schema.Number,
  ts: Schema.Number,
  fqn: Schema.optional(Schema.String),
  payload: Schema.Unknown,
});

/**
 * `begin` conflict: a live deployment already holds `(stack, stage)`.
 * 409 Conflict — decoded by the client into the typed
 * `DeploymentInProgress` error and passed through untouched (it must never
 * be retried as if it were a transport blip).
 */
export const DeploymentInProgressWire = Schema.TaggedStruct(
  "DeploymentInProgress",
  {
    stack: Schema.String,
    stage: Schema.String,
    holder: DeploymentRecordWire,
  },
).pipe(HttpApiSchema.status(409));

/** The supplied token does not match the deployment's open token. 403. */
export const DeploymentTokenInvalidWire = Schema.TaggedStruct(
  "DeploymentTokenInvalid",
  {
    stack: Schema.String,
    stage: Schema.String,
    version: Schema.Number,
  },
).pipe(HttpApiSchema.status(403));

/**
 * The referenced deployment version does not exist. 410 Gone — deliberately
 * NOT 404, so a real missing-version error can never be confused with the
 * transient 404s a freshly-deployed worker serves while its route
 * propagates (those must stay retryable at the transport layer).
 */
export const DeploymentNotFoundWire = Schema.TaggedStruct(
  "DeploymentNotFound",
  {
    stack: Schema.String,
    stage: Schema.String,
    version: Schema.Number,
  },
).pipe(HttpApiSchema.status(410));

/**
 * Deployment data at rest failed to decrypt (wrong key or corrupt data).
 * 422 (not 5xx) so corrupt-at-rest data fails fast instead of being
 * retried as a transient server error; the client folds it into
 * `StateStoreError`.
 */
export const DeploymentCorruptWire = Schema.TaggedStruct("DeploymentCorrupt", {
  message: Schema.String,
}).pipe(HttpApiSchema.status(422));

/** `(stack, stage, version)` path segments for a single deployment. */
const DeploymentKey = Schema.Struct({
  stack: Schema.String,
  stage: Schema.String,
  version: Schema.Number,
});

export const BeginDeployment = HttpApiEndpoint.post(
  "beginDeployment",
  "/state/stacks/:stack/stages/:stage/deployments",
  {
    params: StackStage,
    payload: Schema.Struct({
      meta: DeploymentMetaWire,
      ttlMillis: Schema.optional(Schema.Number),
      supersede: Schema.optional(Schema.Number),
    }).pipe(HttpApiSchema.asJson()),
    success: Schema.Struct({
      version: Schema.Number,
      token: Schema.String,
    }),
    error: [DeploymentInProgressWire, DeploymentCorruptWire],
  },
);

export const AppendDeploymentEvents = HttpApiEndpoint.post(
  "appendDeploymentEvents",
  "/state/stacks/:stack/stages/:stage/deployments/:version/events",
  {
    params: DeploymentKey,
    payload: Schema.Struct({
      token: Schema.String,
      events: Schema.Array(DeploymentEventWire),
    }).pipe(HttpApiSchema.asJson()),
    success: Schema.Struct({ ackedSeq: Schema.Number }),
    error: [DeploymentTokenInvalidWire, DeploymentNotFoundWire],
  },
);

export const HeartbeatDeployment = HttpApiEndpoint.post(
  "heartbeatDeployment",
  "/state/stacks/:stack/stages/:stage/deployments/:version/heartbeat",
  {
    params: DeploymentKey,
    payload: Schema.Struct({ token: Schema.String }).pipe(
      HttpApiSchema.asJson(),
    ),
    success: HttpApiSchema.NoContent,
    error: [DeploymentTokenInvalidWire, DeploymentNotFoundWire],
  },
);

export const EndDeployment = HttpApiEndpoint.post(
  "endDeployment",
  "/state/stacks/:stack/stages/:stage/deployments/:version/end",
  {
    params: DeploymentKey,
    payload: Schema.Struct({
      token: Schema.String,
      outcome: Schema.Literals(["succeeded", "failed", "interrupted"]),
      summary: Schema.optional(DeploymentSummaryWire),
    }).pipe(HttpApiSchema.asJson()),
    success: HttpApiSchema.NoContent,
    error: [DeploymentTokenInvalidWire, DeploymentNotFoundWire],
  },
);

export const ListDeployments = HttpApiEndpoint.get(
  "listDeployments",
  "/state/stacks/:stack/stages/:stage/deployments",
  {
    params: StackStage,
    query: Schema.Struct({
      before: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    }),
    success: Schema.Array(DeploymentRecordWire),
    error: DeploymentCorruptWire,
  },
);

export const GetDeployment = HttpApiEndpoint.get(
  "getDeployment",
  "/state/stacks/:stack/stages/:stage/deployments/:version",
  {
    params: DeploymentKey,
    success: Schema.UndefinedOr(DeploymentRecordWire),
    error: DeploymentCorruptWire,
  },
);

export const ReadDeploymentEvents = HttpApiEndpoint.get(
  "readDeploymentEvents",
  "/state/stacks/:stack/stages/:stage/deployments/:version/events",
  {
    params: DeploymentKey,
    query: Schema.Struct({
      fromSeq: Schema.optional(Schema.Number),
    }),
    success: Schema.Array(DeploymentEventWire),
    error: [DeploymentNotFoundWire, DeploymentCorruptWire],
  },
);

/**
 * Batch read of every resource in a stage — `fqn -> PersistedState`.
 * Kills the N+1 `list` + per-fqn `get` pattern for dashboard readers.
 * Lives under `/all` (not `/resources/:fqn`) so it can never be shadowed
 * by an fqn literally named "all".
 */
export const GetAllStates = HttpApiEndpoint.get(
  "getAllStates",
  "/state/stacks/:stack/stages/:stage/all",
  {
    params: StackStage,
    success: ResourceStateSchema,
  },
);

/**
 * Version of the State Store wire / behavioural contract.
 *
 * Bump this whenever the wire format or runtime behaviour of an HTTP
 * state-store changes in a way that an older deployed copy can no
 * longer satisfy. Clients query `/version` on the deployed worker and
 * compare against this constant; a mismatch (or 404) triggers a
 * forced redeploy via the bootstrap flow.
 */
export const STATE_STORE_VERSION = 5 as const;

/**
 * Optional capabilities a deployed store advertises on `/version`.
 *
 * Additive features negotiate through this list INSTEAD of bumping
 * `STATE_STORE_VERSION`. A bump forces every deployed store to upgrade
 * before the next deploy can run; a capability is just absent on an
 * older store, and the client turns the feature off for that store.
 * Only a change an older copy can no longer *safely* satisfy (an
 * altered or removed endpoint) justifies a version bump.
 */
export type StateStoreCapability = "deployments";

/** Response shape for the unauthenticated `/version` probe. */
export const VersionResponse = Schema.Struct({
  version: Schema.Number,
  /**
   * Absent on stores deployed before capability negotiation existed —
   * `Schema.optional` so those responses still decode, and an absent
   * list reads as "no optional features".
   */
  capabilities: Schema.optional(Schema.Array(Schema.String)),
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
  .add(GetStackOutput)
  .add(SetStackOutput)
  .add(GetAllStates)
  .add(BeginDeployment)
  .add(AppendDeploymentEvents)
  .add(HeartbeatDeployment)
  .add(EndDeployment)
  .add(ListDeployments)
  .add(GetDeployment)
  .add(ReadDeploymentEvents)
  .middleware(StateAuth) {}

export class VersionGroup extends HttpApiGroup.make("version").add(
  GetVersion,
) {}

export class StateApi extends HttpApi.make("alchemy-state")
  .add(StateGroup)
  .add(VersionGroup) {}
