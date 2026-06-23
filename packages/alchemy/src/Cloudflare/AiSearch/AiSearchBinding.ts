import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { AiSearchInstance } from "./AiSearchInstance.ts";
import type { AiSearchNamespace } from "./AiSearchNamespace.ts";
import type { Providers } from "../Providers.ts";

/**
 * Error raised by AI Search runtime binding operations.
 */
export class AiSearchError extends Data.TaggedError("AiSearchError")<{
  /**
   * Human-readable runtime error message.
   */
  message: string;
  /**
   * Original error thrown by the Cloudflare AI Search runtime binding.
   */
  cause: unknown;
}> {}

/**
 * Effect-native client for a Cloudflare AI Search Worker binding.
 *
 * Wraps the standalone `AiSearchInstance` runtime binding (the binding the
 * `ai_search` type resolves to — the deprecated `AutoRAG` shape is gone) so
 * each operation returns an Effect tagged with {@link AiSearchError}. Obtain
 * one from `Cloudflare.AiSearchInstance.bind(instance)` (or a namespace
 * client's `.get(instanceName)`) during the Worker's init phase.
 */
export interface AiSearchClient {
  /**
   * Effect resolving to the raw underlying Cloudflare `AiSearchInstance`
   * binding. Use this for operations not surfaced below (`items`, `jobs`,
   * `update`, or streaming `chatCompletions`).
   */
  raw: Effect.Effect<runtime.AiSearchInstance, never, RuntimeContext>;
  /**
   * Retrieve the chunks most relevant to a query without generation.
   */
  search(
    params: runtime.AiSearchSearchRequest,
  ): Effect.Effect<
    runtime.AiSearchSearchResponse,
    AiSearchError,
    RuntimeContext
  >;
  /**
   * Run retrieval-augmented generation: retrieve relevant chunks and answer
   * with the configured model (non-streaming).
   */
  chatCompletions(
    params: runtime.AiSearchChatCompletionsRequest,
  ): Effect.Effect<
    runtime.AiSearchChatCompletionsResponse,
    AiSearchError,
    RuntimeContext
  >;
  /**
   * Metadata about this instance (id, models, source, status, …).
   */
  info(): Effect.Effect<
    runtime.AiSearchInstanceInfo,
    AiSearchError,
    RuntimeContext
  >;
  /**
   * Indexing statistics (item counts per status, last activity, engine).
   */
  stats(): Effect.Effect<
    runtime.AiSearchStatsResponse,
    AiSearchError,
    RuntimeContext
  >;
}

const tryAiSearch = <A>(
  fn: () => Promise<A>,
): Effect.Effect<A, AiSearchError> =>
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
 * `AiSearchInstance` runtime binding. The resolution is deferred so
 * `.bind(...)` works at both plan time (where `WorkerEnvironment` is absent)
 * and runtime.
 */
const makeClient = (
  rawEff: Effect.Effect<runtime.AiSearchInstance>,
): AiSearchClient => {
  const use = <A>(fn: (raw: runtime.AiSearchInstance) => Promise<A>) =>
    Effect.flatMap(rawEff, (raw) => tryAiSearch(() => fn(raw)));
  return {
    raw: rawEff,
    search: (params) => use((raw) => raw.search(params)),
    chatCompletions: (params) => use((raw) => raw.chatCompletions(params)),
    info: () => use((raw) => raw.info()),
    stats: () => use((raw) => raw.stats()),
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
 * `ai_search` binding resolves directly to a runtime `AiSearchInstance`.
 *
 * Provide {@link AiSearchInstanceBindingLive} in the Worker's runtime layer.
 *
 * @binding
 * @category AI
 *
 * @section Querying AI Search
 * @example Retrieve and generate from a Worker
 * Bind the instance during the Worker's init phase, then use `search`
 * (retrieval only) or `chatCompletions` (retrieval + generation) from request
 * handlers.
 * ```typescript
 * const search = yield* Cloudflare.AiSearchInstance.bind(instance);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const answer = yield* search.chatCompletions({
 *       messages: [{ role: "user", content: "How do I deploy?" }],
 *     });
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
      const rawEff = yield* resolveBinding<runtime.AiSearchInstance>(
        instance.LogicalId,
      );
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
  (instance: AiSearchInstance) => Effect.Effect<void>,
  Providers
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
              instanceName: instance.instanceId,
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
 * Effect-native client for an `ai_search_namespace` binding, wrapping the
 * runtime `AiSearchNamespace`. `.get(name)` selects an instance within the
 * bound namespace and returns its {@link AiSearchClient}; `list` / `search`
 * operate across the namespace.
 */
export interface AiSearchNamespaceClient {
  /**
   * Effect resolving to the raw underlying Cloudflare `AiSearchNamespace`
   * binding. Use this for operations not surfaced below (`create`, `delete`,
   * multi-instance `chatCompletions`).
   */
  raw: Effect.Effect<runtime.AiSearchNamespace, never, RuntimeContext>;
  /**
   * Select an instance within the bound namespace by name.
   */
  get(instanceName: string): AiSearchClient;
  /**
   * List the instances within the bound namespace.
   */
  list(
    params?: runtime.AiSearchListInstancesParams,
  ): Effect.Effect<runtime.AiSearchListResponse, AiSearchError, RuntimeContext>;
  /**
   * Search across multiple instances in the bound namespace (requires
   * `ai_search_options.instance_ids`).
   */
  search(
    params: runtime.AiSearchMultiSearchRequest,
  ): Effect.Effect<
    runtime.AiSearchMultiSearchResponse,
    AiSearchError,
    RuntimeContext
  >;
}

/**
 * Binding service turning an {@link AiSearchNamespace} into an
 * {@link AiSearchNamespaceClient} for Worker runtime code. The
 * `ai_search_namespace` binding resolves to a runtime `AiSearchNamespace`
 * whose `.get(name)` selects an instance within the namespace at runtime.
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
 *     const answer = yield* ns.get("docs-search").chatCompletions({
 *       messages: [{ role: "user", content: query }],
 *     });
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
      const nsEff = yield* resolveBinding<runtime.AiSearchNamespace>(
        namespace.LogicalId,
      );
      return {
        raw: nsEff,
        get: (instanceName) =>
          makeClient(nsEff.pipe(Effect.map((ns) => ns.get(instanceName)))),
        list: (params) =>
          Effect.flatMap(nsEff, (ns) => tryAiSearch(() => ns.list(params))),
        search: (params) =>
          Effect.flatMap(nsEff, (ns) => tryAiSearch(() => ns.search(params))),
      } satisfies AiSearchNamespaceClient;
    });
  }),
);

/**
 * Deploy-time policy attaching an `ai_search_namespace` binding to a Worker.
 */
export class AiSearchNamespaceBindingPolicy extends Binding.Policy<
  AiSearchNamespaceBindingPolicy,
  (namespace: AiSearchNamespace) => Effect.Effect<void>,
  Providers
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
