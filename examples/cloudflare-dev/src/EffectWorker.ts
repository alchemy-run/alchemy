import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import wasm from "./modules/wasm-example.wasm";

export const KV = Cloudflare.KVNamespace("KV");

interface AddInstance {
  exports: {
    add(a: number, b: number): number;
  };
}

export default class EffectWorker extends Cloudflare.Worker<EffectWorker>()(
  "EffectWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespace.bind(KV);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (new URL(request.url, "http://internal").pathname === "/wasm") {
          const instance = yield* Effect.promise(
            () => WebAssembly.instantiate(wasm) as Promise<AddInstance>,
          );
          return yield* HttpServerResponse.json({
            result: instance.exports.add(3, 4),
          });
        }
        const value = yield* kv.list().pipe(Effect.orDie);
        return yield* HttpServerResponse.json(value);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KVNamespaceBindingLive)),
) {}
