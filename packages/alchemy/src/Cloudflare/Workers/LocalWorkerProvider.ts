import * as Effect from "effect/Effect";
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
        diff: ({ id, news, newBindings, instanceId }) =>
          sidecar.diff({
            id,
            props: news as any,
            bindings: newBindings as any,
            stack,
            instanceId,
          }),
        // The local sidecar `serve` operation is itself a true upsert:
        // it tears down any existing process for the worker name and
        // starts a fresh one with the latest bindings, so observe and
        // sync collapse into a single sidecar call.
        reconcile: ({ id, news, bindings, instanceId }) =>
          sidecar.reconcile({
            id,
            props: news,
            bindings,
            stack,
            instanceId,
          }),
        delete: ({ id }) => sidecar.delete(id),
      };
    }),
  );
