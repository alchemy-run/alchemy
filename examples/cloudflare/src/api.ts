import { $ } from "alchemy-effect";
import * as Assets from "alchemy-effect/cloudflare/assets";
import * as KV from "alchemy-effect/cloudflare/kv";
import * as R2 from "alchemy-effect/cloudflare/r2";
import * as Worker from "alchemy-effect/cloudflare/worker";
import * as Effect from "effect/Effect";

export class MyKV extends KV.Namespace("KV", {
  title: "namespace1",
}) {}

export class MyR2 extends R2.Bucket("R2", {}) {}

export class Api extends Worker.serve("Api", {
  fetch: Effect.fn(function* (request) {
    const { pathname } = new URL(request.url);
    console.log("fetch", pathname);
    switch (pathname) {
      case "/": {
        return new Response(
          [
            "Available endpoints:",
            "/kv/get",
            "/kv/put",
            "/r2/get",
            "/r2/put",
            "/<asset>",
          ].join("\n"),
          { status: 200 },
        );
      }
      case "/kv/get": {
        const value = yield* KV.get(MyKV, "test");
        return new Response(value ?? "Not Found", {
          status: value ? 200 : 404,
        });
      }
      case "/kv/put": {
        yield* KV.put(MyKV, "test", crypto.randomUUID());
        return new Response("OK");
      }
      case "/r2/get": {
        const value = yield* R2.get(MyR2, "test");
        if (!value) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(yield* Effect.promise(() => value.text()), {
          status: value ? 200 : 404,
        });
      }
      case "/r2/put": {
        yield* R2.put(MyR2, "test", crypto.randomUUID());
        return new Response("OK");
      }
      default: {
        return yield* Assets.fetch(request);
      }
    }
  }),
})({
  main: import.meta.filename,
  bindings: $(KV.Bind(MyKV), R2.Bind(MyR2)),
  assets: "./assets",
}) {}

export default Api.handler.pipe(Worker.toHandler);
