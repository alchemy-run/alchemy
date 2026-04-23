import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { decodeFqn, encodeFqn } from "../FQN.ts";
import { isResource } from "../Resource.ts";
import { State, StateStoreError, type StateService } from "./State.ts";

const REDACTED_MARKER = "__redacted__";

const encodeState = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (Redacted.isRedacted(value)) {
    return {
      [REDACTED_MARKER]: encodeState(Redacted.value(value)),
    };
  }
  if (isResource(value)) {
    return {
      id: value.LogicalId,
      type: value.Type,
      props: encodeState(value.Props),
      attr: encodeState(value.Attributes),
    };
  }
  if (Array.isArray(value)) return value.map(encodeState);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = encodeState(v);
    }
    return result;
  }
  return value;
};

const reviveState = (_key: string, value: unknown): unknown => {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    REDACTED_MARKER in value
  ) {
    return Redacted.make((value as Record<string, unknown>)[REDACTED_MARKER]);
  }
  return value;
};

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

    const stageDir = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage);

    const resource = ({
      stack,
      stage,
      fqn,
    }: {
      stack: string;
      stage: string;
      fqn: string;
    }) => path.join(stateDir, stack, stage, `${encodeFqn(fqn)}.json`);

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
          Effect.map((file) => JSON.parse(file.toString(), reviveState)),
          recover,
        ),
      getReplacedResources: Effect.fnUntraced(function* (request) {
        return (yield* Effect.all(
          (yield* state.list(request)).map((fqn) =>
            state.get({
              stack: request.stack,
              stage: request.stage,
              fqn,
            }),
          ),
        )).filter((r) => r?.status === "replaced");
      }),
      set: (request) =>
        ensure(stageDir(request)).pipe(
          Effect.flatMap(() =>
            fs.writeFileString(
              resource(request),
              JSON.stringify(encodeState(request.value), null, 2),
            ),
          ),
          recover,
          Effect.map(() => request.value),
        ),
      delete: (request) => fs.remove(resource(request)).pipe(recover),
      list: (request) =>
        fs.readDirectory(stageDir(request)).pipe(
          recover,
          Effect.map(
            (files) =>
              files?.map((file) => decodeFqn(file.replace(/\.json$/, ""))) ??
              [],
          ),
        ),
    };
    return state;
  }),
);
