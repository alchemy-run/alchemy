import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker fixture exercising the Effect-first AI Search bindings:
 * - `AiSearchInstanceBinding.bind(instance)` attaches the single-instance
 *   `ai_search` binding and returns an Effect-native `AiSearchClient`.
 * - `AiSearchNamespaceBinding.bind(namespace)` attaches the
 *   `ai_search_namespace` binding; `.get(name)` scopes to an instance.
 *
 * The `/bindings` route resolves each client's `raw` `AutoRAG` handle and
 * reports its runtime shape — proving the Effect clients wire through to the
 * live runtime bindings (it does not query, which needs indexed data).
 */
export default class AiSearchEffectBindingsWorker extends Cloudflare.Worker<AiSearchEffectBindingsWorker>()(
  "AiSearchEffectBindingsWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket(
      "AiSearchEffectBindingBucket",
      {},
    );
    const namespace = yield* Cloudflare.AiSearchNamespace(
      "AiSearchEffectBindingNs",
      {},
    );
    const instance = yield* Cloudflare.AiSearchInstance(
      "AiSearchEffectBindingInstance",
      { source: bucket.bucketName },
    );
    const search = yield* Cloudflare.AiSearchInstanceBinding.bind(instance);
    const ns = yield* Cloudflare.AiSearchNamespaceBinding.bind(namespace);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.includes("/bindings")) {
          const raw = yield* search.raw;
          const nsRaw = yield* ns.get("docs-search").raw;
          return yield* HttpServerResponse.json({
            mode: "effect",
            searchRaw: typeof raw,
            searchAiSearch: typeof raw.aiSearch,
            searchSearch: typeof raw.search,
            nsRaw: typeof nsRaw,
            nsAiSearch: typeof nsRaw.aiSearch,
          });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.AiSearchInstanceBindingLive,
        Cloudflare.AiSearchNamespaceBindingLive,
      ),
    ),
  ),
) {}
