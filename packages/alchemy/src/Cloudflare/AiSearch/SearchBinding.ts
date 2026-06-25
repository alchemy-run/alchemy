import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Instance } from "./Instance.ts";
import { makeClient, Search } from "./Search.ts";

/**
 * Runtime layer for {@link Search}.
 */
export const SearchBinding = Layer.effect(
  Search,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (instance: Instance) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${instance}`({
          bindings: [
            {
              type: "ai_search",
              name: instance.LogicalId,
              instanceName: instance.instanceId,
              namespace: instance.namespace,
            },
          ],
        });
      }

      const rawEff = Effect.sync(
        () =>
          (env as Record<string, runtime.AiSearchInstance>)[
            instance.LogicalId
          ]!,
      );
      return makeClient(rawEff);
    });
  }),
);
