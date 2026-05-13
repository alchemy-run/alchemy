import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Stack } from "../../Stack.ts";
import { Sidecar } from "../Local/Sidecar.ts";
import { Worker } from "./Worker.ts";

export const LocalWorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const sidecar = yield* Sidecar;
      return {
        diff: ({ id, news, newBindings }) =>
          Effect.gen(function* () {
            if (!isResolved(news) || !isResolved(newBindings)) return undefined;
            return yield* sidecar.diff({
              id,
              props: news,
              bindings: newBindings,
              stack,
            });
          }),
        // The local sidecar `serve` operation is itself a true upsert:
        // it tears down any existing process for the worker name and
        // starts a fresh one with the latest bindings, so observe and
        // sync collapse into a single sidecar call.
        reconcile: ({ id, news, bindings }) =>
          sidecar.reconcile({ id, props: news, bindings, stack }),
        delete: ({ id }) => sidecar.delete(id),
      };
    }),
  );
