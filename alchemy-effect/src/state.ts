import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { App } from "./app.ts";
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

export type ResourceStatus =
  | "creating"
  | "created"
  | "updating"
  | "updated"
  | "deleting"
  | "deleted";

export type ResourceState = {
  type: string;
  id: string;
  status: ResourceStatus;
  props: any;
  output: any;
  bindings?: BindNode[];
};

export class StateStoreError extends Data.TaggedError("StateStoreError")<{
  message: string;
}> {}

export interface StateService {
  listApps(): Effect.Effect<string[], StateStoreError, never>;
  listStages(appName?: string): Effect.Effect<string[], StateStoreError, never>;
  // stub
  get(
    id: string,
  ): Effect.Effect<ResourceState | undefined, StateStoreError, never>;
  set<V extends ResourceState>(
    id: string,
    value: V,
  ): Effect.Effect<V, StateStoreError, never>;
  delete(id: string): Effect.Effect<void, StateStoreError, never>;
  list(): Effect.Effect<string[], StateStoreError, never>;
}

export class State extends Context.Tag("AWS::Lambda::State")<
  State,
  StateService
>() {}

// TODO(sam): implement with SQLite3
export const localFs = Layer.effect(
  State,
  Effect.gen(function* () {
    const app = yield* App;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotAlchemy = path.join(process.cwd(), ".alchemy");
    const stateDir = path.join(dotAlchemy, "state");
    const appDir = path.join(stateDir, app.name);
    const stageDir = path.join(appDir, app.stage);

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

    const resourceFile = (id: string) => path.join(stageDir, `${id}.json`);

    yield* fs.makeDirectory(stageDir, { recursive: true });

    return {
      listApps: () =>
        fs.readDirectory(stateDir).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      listStages: (appName: string = app.name) =>
        fs.readDirectory(path.join(stateDir, appName)).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      get: (id) =>
        fs.readFile(resourceFile(id)).pipe(
          Effect.map((file) => JSON.parse(file.toString())),
          recover,
        ),
      set: <V extends ResourceState>(id: string, value: V) =>
        fs
          .writeFileString(
            resourceFile(id),
            JSON.stringify(
              value,
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
          )
          .pipe(
            recover,
            Effect.map(() => value),
          ),
      delete: (id) => fs.remove(resourceFile(id)).pipe(recover),
      list: () =>
        fs.readDirectory(stageDir).pipe(
          recover,
          Effect.map(
            (files) => files?.map((file) => file.replace(/\.json$/, "")) ?? [],
          ),
        ),
    };
  }),
);

export const inMemory = () => {
  const state = new Map<string, any>();
  return Layer.succeed(State, {
    listApps: () => Effect.succeed([]),
    // oxlint-disable-next-line require-yield
    listStages: (_appName?: string) => Effect.succeed([]),
    get: (id: string) => Effect.succeed(state.get(id)),
    set: <V>(id: string, value: V) => {
      state.set(id, value);
      return Effect.succeed(value);
    },
    delete: (id: string) => {
      state.delete(id);
      return Effect.succeed(undefined);
    },
    list: () => Effect.succeed(Array.from(state.keys())),
  });
};
