import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as path from "pathe";
import AiSearchEffectBindingsWorker from "./effect-bindings-worker.ts";

/**
 * Deploys two Workers covering both AI Search binding flavors via both
 * access styles:
 * - The async worker takes the bindings through `env` (`SEARCH` is a
 *   single-instance `ai_search` binding; `NS` is an `ai_search_namespace`
 *   binding) and reads them as raw runtime objects.
 * - The Effect worker attaches the same two binding flavors via
 *   `AiSearchInstanceBinding.bind(...)` / `AiSearchNamespaceBinding.bind(...)`
 *   and reads them through the Effect-native client.
 *
 * The instance's `source` references the bucket name and the worker's `env`
 * references the instance + namespace, so the engine orders the deploy
 * bucket → instance/namespace → worker.
 */
export default Alchemy.Stack(
  "AiSearchBindingsStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket("AiSearchBindingBucket", {});
    const namespace = yield* Cloudflare.AiSearchNamespace(
      "AiSearchBindingNs",
      {},
    );
    const instance = yield* Cloudflare.AiSearchInstance(
      "AiSearchBindingInstance",
      { source: bucket.bucketName },
    );
    const asyncWorker = yield* Cloudflare.Worker("AiSearchBindingsWorker", {
      main: path.resolve(import.meta.dirname, "bindings-worker.ts"),
      url: true,
      env: { SEARCH: instance, NS: namespace },
    });
    const effectWorker = yield* AiSearchEffectBindingsWorker;
    return {
      url: asyncWorker.url.as<string>(),
      effectUrl: effectWorker.url.as<string>(),
    };
  }),
);
