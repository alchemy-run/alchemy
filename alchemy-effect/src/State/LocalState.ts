import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { isResource } from "../Resource.ts";
import { State, StateStoreError, type StateService } from "./State.ts";

// TODO(sam): implement with SQLite3
export const LocalState = Layer.effect(
  State,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotAlchemy = path.join(process.cwd(), ".alchemy");
    const stateDir = path.join(dotAlchemy, "state");

    const fail = (err: PlatformError) =>
      Effect.fail(
        new StateStoreError({
          message: err.message,
          cause: err,
        }),
      );

    const recover = <T>(effect: Effect.Effect<T, PlatformError, never>) =>
      effect.pipe(
        Effect.catchTag("PlatformError", (e) =>
          e.reason._tag === "NotFound" ? Effect.void : fail(e),
        ),
      );

    const stage = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage);

    const resource = ({
      stack,
      stage,
      logicalId,
    }: {
      stack: string;
      stage: string;
      logicalId: string;
    }) => path.join(stateDir, stack, stage, `${logicalId}.json`);

    const created = new Set<string>();

    const ensure = (dir: string) =>
      created.has(dir)
        ? Effect.succeed(void 0)
        : fs
            .makeDirectory(dir, { recursive: true })
            .pipe(Effect.tap(() => Effect.sync(() => created.add(dir))));

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
          (yield* state.list(request)).map((logicalId) =>
            state.get({
              stack: request.stack,
              stage: request.stage,
              logicalId: logicalId,
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
                      id: v.LogicalId,
                      type: v.Type,
                      props: v.Props,
                      attr: v.Attributes,
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
