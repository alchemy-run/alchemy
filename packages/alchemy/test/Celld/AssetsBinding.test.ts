import { Assets, AssetsBinding } from "@/Celld/AssetsBinding";
import type { Fetcher, NativeFetcher } from "@/Celld/Fetcher";
import { RuntimeContext } from "@/RuntimeContext";
import { WorkerEnvironment } from "@/Workers/Worker";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const fixture = () => {
  const env: Record<string, unknown> = {};
  let initializations = 0;
  const support = Layer.mergeAll(
    Layer.effect(
      WorkerEnvironment,
      Effect.sync(() => {
        initializations++;
        return env;
      }),
    ),
    RuntimeContext.phantom,
  );
  return {
    env,
    initializations: () => initializations,
    layer: AssetsBinding.pipe(Layer.provideMerge(support)),
  };
};

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
export type AssetsContracts = [
  Assert<Equal<Effect.Services<ReturnType<Fetcher["fetch"]>>, RuntimeContext>>,
  Assert<Equal<keyof NativeFetcher, "fetch">>,
];

describe("Celld native assets binding", () => {
  test.effect(
    "captures the environment once and resolves default and named fetchers lazily",
    () => {
      const { env, initializations, layer } = fixture();
      return Effect.gen(function* () {
        const assets = yield* Assets();
        const named = yield* Assets("STATIC");
        expect(initializations()).toBe(1);
        let calls = 0;
        env.ASSETS = {
          fetch: () => {
            calls++;
            return Effect.runPromise(
              Effect.sync(() => new Response("default")),
            );
          },
        };
        env.STATIC = {
          fetch: () => {
            calls++;
            return Effect.runPromise(Effect.sync(() => new Response("named")));
          },
        };
        expect(calls).toBe(0);
        expect(
          yield* (yield* assets.fetch(
            HttpClientRequest.get("https://assets.test/index.html"),
          )).text,
        ).toBe("default");
        expect(
          yield* (yield* named.fetch(
            HttpClientRequest.get("https://assets.test/index.html"),
          )).text,
        ).toBe("named");
        env.ASSETS = {
          fetch: () =>
            Effect.runPromise(Effect.sync(() => new Response("replacement"))),
        };
        expect(
          yield* (yield* assets.fetch(
            HttpClientRequest.get("https://assets.test/index.html"),
          )).text,
        ).toBe("replacement");
        expect(initializations()).toBe(1);
        expect(Assets.key).toBe("Celld.Assets");
      }).pipe(Effect.provide(layer));
    },
  );

  test.effect(
    "forwards server requests and native routing response headers unchanged",
    () => {
      const { env, layer } = fixture();
      return Effect.gen(function* () {
        env.ASSETS = {
          marker: "native assets",
          fetch(this: { marker: string }, input: Request | string | URL) {
            expect(this.marker).toBe("native assets");
            return Effect.runPromise(
              Effect.gen(function* () {
                const request = yield* Effect.sync(() => new Request(input));
                expect(request.method).toBe("GET");
                expect(request.url).toBe("https://assets.test/old?language=en");
                expect(request.headers.get("x-request")).toBe("yes");
                return yield* Effect.sync(
                  () =>
                    new Response(null, {
                      status: 302,
                      headers: { location: "/new", "x-assets": "native" },
                    }),
                );
              }),
            );
          },
        };
        const assets = yield* Assets();
        const request = yield* Effect.sync(() =>
          HttpServerRequest.fromWeb(
            new Request("https://assets.test/old?language=en", {
              headers: { "x-request": "yes" },
            }),
          ),
        );
        const response = HttpServerResponse.toWeb(yield* assets.fetch(request));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/new");
        expect(response.headers.get("x-assets")).toBe("native");
      }).pipe(Effect.provide(layer));
    },
  );

  test.effect(
    "raw access is fetch-only and preserves native binary responses",
    () => {
      const { env, layer } = fixture();
      return Effect.gen(function* () {
        env.ASSETS = {
          fetch: () =>
            Effect.runPromise(
              Effect.sync(() => new Response(new Uint8Array([0, 255, 1]))),
            ),
          connect: () => {
            throw new Error("not a supported capability");
          },
          rpc: () => {
            throw new Error("not a supported capability");
          },
        };
        const assets = yield* Assets();
        expect(Object.keys(assets.raw)).toEqual(["fetch"]);
        expect(Reflect.get(assets, "connect")).toBeUndefined();
        expect(Reflect.get(assets.raw, "rpc")).toBeUndefined();
        const response = yield* Effect.tryPromise(() =>
          assets.raw.fetch("https://assets.test/file.bin"),
        );
        const body = yield* Effect.tryPromise(() => response.arrayBuffer());
        expect(Array.from(new Uint8Array(body))).toEqual([0, 255, 1]);
      }).pipe(Effect.provide(layer));
    },
  );

  test.effect(
    "missing bindings fail at request time without inventing an asset configuration",
    () => {
      const { env, layer } = fixture();
      return Effect.gen(function* () {
        const assets = yield* Assets("MISSING");
        expect(env).toEqual({});
        const result = yield* Effect.result(
          assets.fetch(HttpClientRequest.get("https://assets.test/")),
        );
        expect(Result.isFailure(result) && result.failure._tag).toBe(
          "RpcCallError",
        );
        if (Result.isFailure(result))
          expect(result.failure.message).toContain(
            "configure Worker assets.binding",
          );
        expect(env).toEqual({});
      }).pipe(Effect.provide(layer));
    },
  );

  test.effect(
    "wraps native synchronous throws and rejected fetch promises",
    () => {
      const { env, layer } = fixture();
      return Effect.gen(function* () {
        const assets = yield* Assets();
        for (const native of [
          { fetch: 1 },
          {
            fetch: () => {
              throw null;
            },
          },
          {
            fetch: () =>
              Effect.runPromise(Effect.fail(new Error("native assets failed"))),
          },
        ]) {
          env.ASSETS = native;
          const result = yield* Effect.result(
            assets.fetch(HttpClientRequest.get("https://assets.test/error")),
          );
          expect(Result.isFailure(result) && result.failure._tag).toBe(
            "RpcCallError",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );
});
