/// <reference types="@cloudflare/workers-types" />

import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { AiSearchInstance } from "./Instance.ts";
import type { AiSearchNamespace } from "./Namespace.ts";

/**
 * Error raised by AI Search runtime binding operations.
 */
export class AiSearchError extends Data.TaggedError("AiSearchError")<{
  /**
   * Human-readable runtime error message.
   */
  message: string;
  /**
   * Original error thrown by the Cloudflare `AutoRAG` runtime binding.
   */
  cause: unknown;
}> {}

/**
 * Effect-native client for a Cloudflare AI Search (`AutoRAG`) Worker binding.
 *
 * Wraps the runtime `AutoRAG` binding so each operation returns an Effect
 * tagged with {@link AiSearchError}. Obtain one from
 * `Cloudflare.AiSearchInstanceBinding.bind(instance)` (or
 * `namespace.get(instanceName)`) during the Worker's init phase.
 */
export interface AiSearchClient {
  /**
   * Effect resolving to the raw underlying Cloudflare `AutoRAG` binding. Use
   * this for direct access (e.g. streaming `aiSearch`) not covered below.
   */
  raw: Effect.Effect<runtime.AutoRAG, never, RuntimeContext>;
  /**
   * List the instances reachable through this binding.
   */
  list(): Effect.Effect<
    runtime.AutoRagListResponse,
    AiSearchError,
    RuntimeContext
  >;
  /**
   * Retrieve the chunks most relevant to a query without generation.
   */
  search(
    params: runtime.AutoRagSearchRequest,
  ): Effect.Effect<
    runtime.AutoRagSearchResponse,
    AiSearchError,
    RuntimeContext
  >;
  /**
   * Run retrieval-augmented generation: retrieve relevant chunks and answer
   * the query with the configured model.
   */
  aiSearch(
    params: runtime.AutoRagAiSearchRequest,
  ): Effect.Effect<
    runtime.AutoRagAiSearchResponse,
    AiSearchError,
    RuntimeContext
  >;
}

const tryAutoRag = <A>(fn: () => Promise<A>): Effect.Effect<A, AiSearchError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new AiSearchError({
        message:
          cause instanceof Error
            ? cause.message
            : "Unknown AI Search runtime error",
        cause,
      }),
  });

/**
 * Build an {@link AiSearchClient} from an Effect that lazily resolves the raw
 * `AutoRAG` runtime binding. The resolution is deferred so `.bind(...)` works
 * at both plan time (where `WorkerEnvironment` is absent) and runtime.
 */
const makeClient = (rawEff: Effect.Effect<runtime.AutoRAG>): AiSearchClient => {
  const use = <A>(fn: (raw: runtime.AutoRAG) => Promise<A>) =>
    Effect.flatMap(rawEff, (raw) => tryAutoRag(() => fn(raw)));
  return {
    raw: rawEff,
    list: () => use((raw) => raw.list()),
    search: (params) => use((raw) => raw.search(params)),
    aiSearch: (params) => use((raw) => raw.aiSearch(params)),
  } satisfies AiSearchClient;
};

/**
 * Effect that, when run, yields a memoized Effect resolving the raw runtime
 * binding under `logicalId`. The lookup is deferred via `WorkerEnvironment`
 * (absent at plan time) so `.bind(...)` is safe in both phases.
 */
const resolveBinding = <T>(logicalId: string) =>
  Effect.serviceOption(WorkerEnvironment).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.map((env) => (env as Record<string, T> | undefined)?.[logicalId]!),
    Effect.cached,
  );

/**
 * Binding service turning an {@link AiSearchInstance} into an Effect-native
 * {@link AiSearchClient} for Worker runtime code. The single-instance
 * `ai_search` binding resolves directly to an `AutoRAG`.
 *
 * Provide {@link AiSearchInstanceBindingLive} in the Worker's runtime layer.
 *
 * @binding
 * @category AI
 *
 * @section Querying AI Search
 * @example Search and answer from a Worker
 * Bind the instance during the Worker's init phase, then use `search` /
 * `aiSearch` from request handlers.
 * ```typescript
 * const search = yield* Cloudflare.AiSearchInstanceBinding.bind(instance);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const answer = yield* search.aiSearch({ query: "How do I deploy?" });
 *     return yield* HttpServerResponse.json(answer);
 *   }),
 * };
 * ```
 */
export class AiSearchInstanceBinding extends Binding.Service<
  AiSearchInstanceBinding,
  (instance: AiSearchInstance) => Effect.Effect<AiSearchClient>
>()("Cloudflare.AiSearch.InstanceBinding") {}

/**
 * Runtime layer for {@link AiSearchInstanceBinding}.
 */
export const AiSearchInstanceBindingLive = Layer.effect(
  AiSearchInstanceBinding,
  Effect.gen(function* () {
    const Policy = yield* AiSearchInstanceBindingPolicy;
    return Effect.fn(function* (instance: AiSearchInstance) {
      yield* Policy(instance);
      const rawEff = yield* resolveBinding<runtime.AutoRAG>(instance.LogicalId);
      return makeClient(rawEff);
    });
  }),
);

/**
 * Deploy-time policy attaching a single-instance `ai_search` binding to a
 * Worker.
 */
export class AiSearchInstanceBindingPolicy extends Binding.Policy<
  AiSearchInstanceBindingPolicy,
  (instance: AiSearchInstance) => Effect.Effect<void>
>()("Cloudflare.AiSearch.InstanceBinding") {}

/**
 * Live deploy-time policy layer for {@link AiSearchInstanceBindingPolicy}.
 */
export const AiSearchInstanceBindingPolicyLive =
  AiSearchInstanceBindingPolicy.layer.succeed(
    Effect.fn(function* (host: ResourceLike, instance: AiSearchInstance) {
      if (isWorker(host)) {
        yield* host.bind`${instance}`({
          bindings: [
            {
              type: "ai_search",
              name: instance.LogicalId,
              instanceName: instance.id,
              namespace: instance.namespace,
            },
          ],
        });
      } else {
        return yield* Effect.die(
          new Error(
            `AiSearchInstanceBinding does not support runtime '${host.Type}'`,
          ),
        );
      }
    }),
  );

/**
 * Effect-native client for an `ai_search_namespace` binding. `.get(name)`
 * selects an instance within the bound namespace and returns its
 * {@link AiSearchClient}.
 */
export interface AiSearchNamespaceClient {
  /**
   * Select an instance within the bound namespace by name.
   */
  get(instanceName: string): AiSearchClient;
}

/**
 * Binding service turning an {@link AiSearchNamespace} into an
 * {@link AiSearchNamespaceClient} for Worker runtime code. The
 * `ai_search_namespace` binding resolves to an object whose `.get(name)`
 * selects an instance within the namespace at runtime.
 *
 * Provide {@link AiSearchNamespaceBindingLive} in the Worker's runtime layer.
 *
 * @binding
 * @category AI
 *
 * @section Querying a namespace
 * @example Select an instance at runtime
 * ```typescript
 * const ns = yield* Cloudflare.AiSearchNamespaceBinding.bind(namespace);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const answer = yield* ns.get("docs-search").aiSearch({ query });
 *     return yield* HttpServerResponse.json(answer);
 *   }),
 * };
 * ```
 */
export class AiSearchNamespaceBinding extends Binding.Service<
  AiSearchNamespaceBinding,
  (namespace: AiSearchNamespace) => Effect.Effect<AiSearchNamespaceClient>
>()("Cloudflare.AiSearch.NamespaceBinding") {}

/**
 * Runtime layer for {@link AiSearchNamespaceBinding}.
 */
export const AiSearchNamespaceBindingLive = Layer.effect(
  AiSearchNamespaceBinding,
  Effect.gen(function* () {
    const Policy = yield* AiSearchNamespaceBindingPolicy;
    return Effect.fn(function* (namespace: AiSearchNamespace) {
      yield* Policy(namespace);
      const nsEff = yield* resolveBinding<{
        get(name: string): runtime.AutoRAG;
      }>(namespace.LogicalId);
      return {
        get: (instanceName) =>
          makeClient(nsEff.pipe(Effect.map((ns) => ns.get(instanceName)))),
      } satisfies AiSearchNamespaceClient;
    });
  }),
);

/**
 * Deploy-time policy attaching an `ai_search_namespace` binding to a Worker.
 */
export class AiSearchNamespaceBindingPolicy extends Binding.Policy<
  AiSearchNamespaceBindingPolicy,
  (namespace: AiSearchNamespace) => Effect.Effect<void>
>()("Cloudflare.AiSearch.NamespaceBinding") {}

/**
 * Live deploy-time policy layer for {@link AiSearchNamespaceBindingPolicy}.
 */
export const AiSearchNamespaceBindingPolicyLive =
  AiSearchNamespaceBindingPolicy.layer.succeed(
    Effect.fn(function* (host: ResourceLike, namespace: AiSearchNamespace) {
      if (isWorker(host)) {
        yield* host.bind`${namespace}`({
          bindings: [
            {
              type: "ai_search_namespace",
              name: namespace.LogicalId,
              namespace: namespace.name,
            },
          ],
        });
      } else {
        return yield* Effect.die(
          new Error(
            `AiSearchNamespaceBinding does not support runtime '${host.Type}'`,
          ),
        );
      }
    }),
  );
