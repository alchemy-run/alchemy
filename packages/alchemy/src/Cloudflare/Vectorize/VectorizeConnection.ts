import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Binding from "../../Binding.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import type { VectorizeIndex } from "./VectorizeIndex.ts";
import { IndexBinding } from "./VectorizeIndexBinding.ts";

export interface VectorizeConnectionClient {
  /**
   * An Effect that resolves to the raw underlying Cloudflare Vectorize
   * binding. Use this for direct access not covered by the helpers below.
   */
  raw: Effect.Effect<runtime.Vectorize>;
  /** Get information about the bound index (dimensions, vector count). */
  describe: () => Effect.Effect<runtime.VectorizeIndexInfo>;
  /** Find the nearest neighbors of `vector`. */
  query: (
    vector: runtime.VectorFloatArray | number[],
    options?: runtime.VectorizeQueryOptions,
  ) => Effect.Effect<runtime.VectorizeMatches>;
  /** Find the nearest neighbors of an existing vector by its id. */
  queryById: (
    vectorId: string,
    options?: runtime.VectorizeQueryOptions,
  ) => Effect.Effect<runtime.VectorizeMatches>;
  /** Insert vectors. Throws if any provided id already exists. */
  insert: (
    vectors: runtime.VectorizeVector[],
  ) => Effect.Effect<runtime.VectorizeAsyncMutation>;
  /** Upsert vectors, replacing any existing vectors with matching ids. */
  upsert: (
    vectors: runtime.VectorizeVector[],
  ) => Effect.Effect<runtime.VectorizeAsyncMutation>;
  /** Delete vectors by id. */
  deleteByIds: (ids: string[]) => Effect.Effect<runtime.VectorizeAsyncMutation>;
  /** Fetch vectors by id. */
  getByIds: (ids: string[]) => Effect.Effect<runtime.VectorizeVector[]>;
}

export class VectorizeConnection extends Binding.Service<
  VectorizeConnection,
  (index: VectorizeIndex) => Effect.Effect<VectorizeConnectionClient>
>()("Cloudflare.Vectorize.Connection") {}

export const VectorizeConnectionLive = Layer.effect(
  VectorizeConnection,
  Effect.gen(function* () {
    const Policy = yield* VectorizeConnectionPolicy;

    return Effect.fn(function* (index: VectorizeIndex) {
      yield* Policy(index);
      const rawEff = yield* Effect.serviceOption(WorkerEnvironment).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((env) => env?.[index.LogicalId]! as runtime.Vectorize),
        Effect.cached,
      );

      const withRuntime = <A>(fn: (raw: runtime.Vectorize) => Promise<A>) =>
        Effect.flatMap(rawEff, (raw) => Effect.promise(() => fn(raw)));

      return {
        raw: rawEff,
        describe: () => withRuntime((raw) => raw.describe()),
        query: (vector, options) =>
          withRuntime((raw) => raw.query(vector, options)),
        queryById: (vectorId, options) =>
          withRuntime((raw) => raw.queryById(vectorId, options)),
        insert: (vectors) => withRuntime((raw) => raw.insert(vectors)),
        upsert: (vectors) => withRuntime((raw) => raw.upsert(vectors)),
        deleteByIds: (ids) => withRuntime((raw) => raw.deleteByIds(ids)),
        getByIds: (ids) => withRuntime((raw) => raw.getByIds(ids)),
      } satisfies VectorizeConnectionClient;
    });
  }),
);

export class VectorizeConnectionPolicy extends Binding.Policy<
  VectorizeConnectionPolicy,
  (index: VectorizeIndex) => Effect.Effect<void>
>()("Cloudflare.Vectorize.Connection") {}

export const VectorizeConnectionPolicyLive =
  VectorizeConnectionPolicy.layer.succeed(IndexBinding);
