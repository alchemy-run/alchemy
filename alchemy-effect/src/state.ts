import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { BindNode } from "./plan.ts";
import { isResource } from "./resource.ts";

// SQL only?? no
// DynamoDB is faster but bounded to 400KB (<10ms minimum latency)
// S3 is slower but unbounded in size (200ms minimum latency)
// -> dual purpose for assets
// -> batching? or one file? -> Pipeline to one file. Versioned S3 Object for logs.
// -> concern with one file is size: some of our resources have like the whole fucking lambda
//    -> hash them? or etag. etag is md5
//    -> there are more large data that aren't files?
//       -> e.g. asset manifest
//       -> pointer to one file? too clever?
// -> sqlite on S3?
// SQlite on EFS. But needs a VPN.
// Roll back just from the state store??? -> needs to be fast and "build-less"
// JSON or Message Pack? I vote JSON (easy to read)

// Artifact -> stored hash only, compared on hash, not available during DELETE
// -> can't rollback just from state
// -> store it as a separate file, avoid re-writes, etc.

// SQLite in S3
// -> download, do all updates locally, upload?
// -> stream uploads
// -> not durable, but we accept that we CANT be durable
// -> it's also fast if you don't upload often

// S3 would still be fast because we sync locally

// ## Encryption
// ALCHEMY_PASSWORD suck
// ALCHEMY_STATE_TOKEN suck
// We are flattening (no more nested any state)

// in AWS this is easy - SSE (SSE + KMS)
// -> some companies would prefer CSE

// Library level encryption (SDK) -> default to no-op, favor SSE on AWS S3
// On AWS it would be KMS (we can just use IAM Role)
// On CF -> generate a Token and store in Secrets Manager?
//   -> Store it in R2 because we can't get it out?
//   -> Or build KMS on top of Workers+DO?
//   -> R2 lets us use OAuth to gain access to the encryption token

// Scrap the "key-value" store on State/Scope

export type Props = Record<string, any>;
export type Attr = Record<string, any>;

export type ResourceStatus = ResourceState["status"];

interface BaseResourceState {
  resourceType: string;
  /** Logical ID of the Resource (stable across creates, updates, deletes and replaces) */
  logicalId: string;
  /** A unique randomly generated token used to seed ID generation (only changes when replaced) */
  instanceId: string;
  /** The version of the provider that was used to create/update the resource. */
  providerVersion: number;
  /** Current status of the logical Resource */
  status: ResourceStatus;
  /** List of logical IDs of resources that depend on this resource */
  downstream: string[];
  /** List of Bindings attached to this Resource */
  bindings?: BindNode[];
  /** Desired state (input props) of this Resource */
  props?: Props;
  /** The output attributes of this Resource (if it has been created) */
  attr?: Attr;
}

export interface CreatingResourceState extends BaseResourceState {
  status: "creating";
  /** The new resource properties that are being (or have been) applied. */
  props: Props;
}

export interface CreatedResourceState extends BaseResourceState {
  status: "created";
  /** The new resource properties that have been applied. */
  props: Props;
  /** The output attributes of the created resource */
  attr: Attr;
}

export interface UpdatingReourceState extends BaseResourceState {
  status: "updating";
  /** The new resource properties that are being (or have been) applied. */
  props: Props;
  old: {
    /** The old resource properties that have been successfully applied. */
    props: Props;
    /** The old output properties that have been successfully applied. */
    attr: Attr;
    // TODO(sam): do I need to track the old downstream edges?
    // downstream: string[];
  };
}

export interface UpdatedResourceState extends BaseResourceState {
  status: "updated";
  /** The new resource properties that are being (or have been) applied. */
  props: Props;
  /** The output attributes of the created resource */
  attr: Attr;
}

export interface DeletingResourceState extends BaseResourceState {
  status: "deleting";
  /** Attributes of the resource being deleted */
  attr: Attr | undefined;
}

export interface ReplacingResourceState extends BaseResourceState {
  status: "replacing";
  /** Desired properties of the new resource (the replacement) */
  props: Props;
  /** Reference to the state of the old resource (the one being replaced) */
  old:
    | CreatedResourceState
    | UpdatedResourceState
    | CreatingResourceState
    | UpdatingReourceState
    | DeletingResourceState;
  /** Whether the resource should be deleted before or after replacements */
  deleteFirst: boolean;
}

export interface ReplacedResourceState extends BaseResourceState {
  status: "replaced";
  /** Desired properties of the new resource (the replacement) */
  props: Props;
  /** Output attributes of the new resource (the replacement) */
  attr: Attr;
  /** Reference to the state of the old resource (the one being replaced) */
  old:
    | CreatingResourceState
    | CreatedResourceState
    | UpdatingReourceState
    | UpdatedResourceState
    | DeletingResourceState;
  /** Whether the resource should be deleted before or after replacements */
  deleteFirst: boolean;
  // .. will (finally) transition to `CreatedResourceState` after finalizing
}

export type ResourceState =
  | CreatingResourceState
  | CreatedResourceState
  | UpdatingReourceState
  | UpdatedResourceState
  | DeletingResourceState
  | ReplacingResourceState
  | ReplacedResourceState;

export class StateStoreError extends Data.TaggedError("StateStoreError")<{
  message: string;
}> {}

export interface StateService {
  listStacks(): Effect.Effect<string[], StateStoreError, never>;
  listStages(stack: string): Effect.Effect<string[], StateStoreError, never>;
  // stub
  get(request: {
    stack: string;
    stage: string;
    resourceId: string;
  }): Effect.Effect<ResourceState | undefined, StateStoreError, never>;
  getReplacedResources(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<ReplacedResourceState[], StateStoreError, never>;
  set<V extends ResourceState>(request: {
    stack: string;
    stage: string;
    resourceId: string;
    value: V;
  }): Effect.Effect<V, StateStoreError, never>;
  delete(request: {
    stack: string;
    stage: string;
    resourceId: string;
  }): Effect.Effect<void, StateStoreError, never>;
  list(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<string[], StateStoreError, never>;
}

export class State extends Context.Tag("AWS::Lambda::State")<
  State,
  StateService
>() {}

// TODO(sam): implement with SQLite3
export const localFs = Layer.effect(
  State,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotAlchemy = path.join(process.cwd(), ".alchemy");
    const stateDir = path.join(dotAlchemy, "state");

    const fail = (err: PlatformError) =>
      Effect.fail(
        new StateStoreError({
          message: err.description ?? err.message,
        }),
      );

    const recover = <T>(effect: Effect.Effect<T, PlatformError, never>) =>
      effect.pipe(
        Effect.catchTag("SystemError", (e) =>
          e.reason === "NotFound" ? Effect.succeed(undefined) : fail(e),
        ),
        Effect.catchTag("BadArgument", (e) => fail(e)),
      );

    const stage = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage);

    const resource = ({
      stack,
      stage,
      resourceId,
    }: {
      stack: string;
      stage: string;
      resourceId: string;
    }) => path.join(stateDir, stack, stage, `${resourceId}.json`);

    const ensure = yield* Effect.cachedFunction((dir: string) =>
      fs.makeDirectory(dir, { recursive: true }),
    );

    const state: StateService = {
      listStacks: () =>
        fs.readDirectory(stateDir).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      listStages: (stack: string) =>
        fs.readDirectory(path.join(stateDir, stack)).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      get: (request) =>
        fs.readFile(resource(request)).pipe(
          Effect.map((file) => JSON.parse(file.toString())),
          recover,
        ),
      getReplacedResources: Effect.fnUntraced(function* (request) {
        return (yield* Effect.all(
          (yield* state.list(request)).map((resourceId) =>
            state.get({
              stack: request.stack,
              stage: request.stage,
              resourceId,
            }),
          ),
        )).filter((r) => r?.status === "replaced");
      }),
      set: (request) =>
        ensure(stage(request)).pipe(
          Effect.flatMap(() =>
            fs.writeFileString(
              resource(request),
              JSON.stringify(
                request.value,
                (k, v) => {
                  if (isResource(v)) {
                    return {
                      id: v.id,
                      type: v.type,
                      props: v.props,
                      attr: v.attr,
                    };
                  }
                  return v;
                },
                2,
              ),
            ),
          ),
          recover,
          Effect.map(() => request.value),
        ),
      delete: (request) => fs.remove(resource(request)).pipe(recover),
      list: (request) =>
        fs.readDirectory(stage(request)).pipe(
          recover,
          Effect.map(
            (files) => files?.map((file) => file.replace(/\.json$/, "")) ?? [],
          ),
        ),
    };
    return state;
  }),
);

type StackId = string;
type StageId = string;
type ResourceId = string;

export const inMemory = (
  initialState: Record<
    StackId,
    Record<StageId, Record<ResourceId, ResourceState>>
  > = {},
) =>
  Layer.succeed(State, inMemoryService(initialState)) as Layer.Layer<
    State,
    never,
    never
  >;

export const inMemoryService = (
  initialState: Record<
    StackId,
    Record<StageId, Record<ResourceId, ResourceState>>
  > = {},
) => {
  const state = initialState;
  return {
    listStacks: () => Effect.succeed(Array.from(Object.keys(state))),
    // oxlint-disable-next-line require-yield
    listStages: (stack: string) =>
      Effect.succeed(
        Array.from(stack in state ? Object.keys(state[stack]) : []),
      ),
    get: ({
      stack,
      stage,
      resourceId,
    }: {
      stack: string;
      stage: string;
      resourceId: string;
    }) => Effect.succeed(state[stack]?.[stage]?.[resourceId]),
    getReplacedResources: ({
      stack,
      stage,
    }: {
      stack: string;
      stage: string;
    }) =>
      Effect.succeed(
        Array.from(Object.values(state[stack]?.[stage] ?? {}) ?? []).filter(
          (s) => s.status === "replaced",
        ),
      ),
    set: <V extends ResourceState>({
      stack,
      stage,
      resourceId,
      value,
    }: {
      stack: string;
      stage: string;
      resourceId: string;
      value: V;
    }) => {
      const stackState = (state[stack] ??= {});
      const stageState = (stackState[stage] ??= {});
      stageState[resourceId] = value;
      return Effect.succeed(value);
    },
    delete: ({
      stack,
      stage,
      resourceId,
    }: {
      stack: string;
      stage: string;
      resourceId: string;
    }) => Effect.succeed(delete state[stack]?.[stage]?.[resourceId]),
    list: ({ stack, stage }: { stack: string; stage: string }) =>
      Effect.succeed(
        Array.from(Object.keys(state[stack]?.[stage] ?? {}) ?? []),
      ),
  } satisfies StateService;
};
