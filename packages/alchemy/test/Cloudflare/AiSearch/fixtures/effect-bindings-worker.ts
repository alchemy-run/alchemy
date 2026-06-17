import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker fixture exercising the Effect-first AI Search bindings:
 * - `AiSearchInstanceBinding.bind(search)` attaches the single-instance
 *   `ai_search` binding and returns an Effect-native `AiSearchClient`. The
 *   `search` is the `AiSearch` construct's result — proving it's usable
 *   anywhere an `AiSearchInstance` is, here passed straight to `bind(...)`.
 * - `AiSearchNamespaceBinding.bind(namespace)` attaches the
 *   `ai_search_namespace` binding; `.get(name)` scopes to an instance.
 *
 * The `/bindings` route resolves each client's `raw` runtime handle (an
 * `AiSearchInstance` / `AiSearchNamespace`) and reports its runtime shape —
 * proving the Effect clients wire through to the live runtime bindings (it
 * does not query, which needs indexed data).
 */
export default class AiSearchEffectBindingsWorker extends Cloudflare.Worker<AiSearchEffectBindingsWorker>()(
  "AiSearchEffectBindingsWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket("AiSearchEffectBindingBucket");
    const namespace = yield* Cloudflare.AiSearchNamespace(
      "AiSearchEffectBindingNs",
    );
    const aiSearch = yield* Cloudflare.AiSearch(
      "AiSearchEffectBindingInstance",
      { source: bucket },
    );
    const search = yield* Cloudflare.AiSearchInstance.bind(aiSearch);
    const ns = yield* Cloudflare.AiSearchNamespace.bind(namespace);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.includes("/bindings")) {
          const raw = yield* search.raw;
          const nsRaw = yield* ns.raw;
          return yield* HttpServerResponse.json({
            mode: "effect",
            searchRaw: typeof raw,
            searchChatCompletions: typeof raw.chatCompletions,
            searchSearch: typeof raw.search,
            nsRaw: typeof nsRaw,
            nsChatCompletions: typeof nsRaw.get("docs-search").chatCompletions,
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
