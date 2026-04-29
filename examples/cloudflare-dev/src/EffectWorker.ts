import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const KV = Cloudflare.KVNamespace("KV");

export default class EffectWorker extends Cloudflare.Worker<EffectWorker>()(
  "EffectWorker",
  {
    main: import.meta.path,
  },
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespace.bind(KV);
    return {
      fetch: Effect.gen(function* () {
        const value = yield* kv.list().pipe(Effect.orDie);
        return HttpServerResponse.jsonUnsafe(value);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KVNamespaceBindingLive)),
) {}
