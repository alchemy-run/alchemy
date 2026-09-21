import {
  fromDurableObjectState,
  fromNativeFacets,
  type FacetStartupOptions,
  type NativeDurableObjectFacets,
} from "@/Celld/DurableObjectState.ts";
import type { NativeDurableObjectClass } from "@/Celld/WorkerLoader.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { nativeState } from "./fixtures/native-state.ts";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

class Value extends Context.Service<Value, string>()("State.Test.Value") {}

const services = Layer.mergeAll(
  RuntimeContext.phantom,
  Layer.succeed(Value, "request service"),
);

describe("Celld provider-owned DurableObjectState", () => {
  it.effect(
    "preserves storage, websocket access, raw identity, and concurrency callback context",
    () =>
      Effect.gen(function* () {
        const pending: Promise<unknown>[] = [];
        const raw = yield* Effect.sync(() => nativeState(pending));
        const state = fromDurableObjectState(raw);
        expect(state.raw).toBe(raw);
        expect(state.exports).toBe(raw.exports);
        expect(state.props).toEqual({ key: "value" });
        expect(state.container).toBeUndefined();
        expect(yield* state.storage.get("key")).toBeUndefined();
        expect(yield* state.storage.get(["key"])).toEqual(new Map());
        expect(yield* state.getWebSockets()).toEqual([]);
        expect(yield* state.blockConcurrencyWhile(() => Value)).toBe(
          "request service",
        );
        yield* state.waitUntil(Value);
        expect(yield* Effect.promise(() => pending[0]!)).toBe(
          "request service",
        );
      }).pipe(Effect.provide(services)),
  );

  it.effect(
    "forwards native abort and auto-response without Cloudflare-only options",
    () =>
      Effect.gen(function* () {
        const raw = yield* Effect.sync(() => nativeState([]));
        const calls: unknown[][] = [];
        let pair: Parameters<typeof raw.setWebSocketAutoResponse>[0];
        raw.abort = (...args) => {
          calls.push(args);
        };
        raw.setWebSocketAutoResponse = (value) => {
          pair = value;
        };
        raw.getWebSocketAutoResponse = () => pair ?? null;
        const state = fromDurableObjectState(raw);
        expect(yield* state.getWebSocketAutoResponse()).toBeNull();
        yield* state.setWebSocketAutoResponse({
          request: "ping",
          response: "pong",
        });
        expect(yield* state.getWebSocketAutoResponse()).toEqual({
          request: "ping",
          response: "pong",
        });
        yield* state.setWebSocketAutoResponse();
        expect(yield* state.getWebSocketAutoResponse()).toBeNull();
        yield* state.abort("reset");
        expect(calls).toEqual([["reset"]]);
        expect("setHibernatableWebSocketEventTimeout" in state).toBe(false);
      }).pipe(Effect.provide(services)),
  );

  it.effect(
    "facets preserve lazy startup context and expose schedule-only abort/delete",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let callback:
          | (() => FacetStartupOptions | Promise<FacetStartupOptions>)
          | undefined;
        const token = Object.freeze({}) as NativeDurableObjectClass;
        const native: NativeDurableObjectFacets = {
          get: (name, getOptions) => {
            calls.push(`get:${name}`);
            callback = getOptions;
            return {
              fetch: () =>
                Effect.runPromise(Effect.sync(() => new Response("facet"))),
            };
          },
          abort: (name) => {
            calls.push(`abort:${name}`);
          },
          delete: (name) => {
            calls.push(`delete:${name}`);
          },
        };
        const facets = fromNativeFacets(() => native);
        expect(calls).toEqual([]);
        const facet = yield* facets.get("child", () =>
          Effect.gen(function* () {
            calls.push(yield* Value);
            return { class: token };
          }),
        );
        expect(calls).toEqual(["get:child"]);
        if (!callback)
          return yield* Effect.die(
            "Native startup callback was not registered",
          );
        const deferred = yield* Effect.sync(callback);
        const options =
          deferred instanceof Promise
            ? yield* Effect.promise(() => deferred)
            : deferred;
        expect(options.class).toBe(token);
        expect(
          yield* (yield* facet.fetch(HttpClientRequest.get("https://facet/")))
            .text,
        ).toBe("facet");
        yield* facets.abort("child", new Error("stop"));
        yield* facets.delete("child");
        expect(calls).toEqual([
          "get:child",
          "request service",
          "abort:child",
          "delete:child",
        ]);
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("native facet validation errors remain typed failures", () =>
    Effect.gen(function* () {
      const facets = fromNativeFacets(() => ({
        get: () => {
          throw new TypeError("Facet nesting depth limit exceeded");
        },
        abort: () => {
          throw new TypeError("name too long");
        },
        delete: () => {
          throw new TypeError("name too long");
        },
      }));
      const result = yield* Effect.result(facets.delete("invalid"));
      expect(Result.isFailure(result) && result.failure._tag).toBe(
        "Celld.DurableObjectFacetError",
      );
    }).pipe(Effect.provide(RuntimeContext.phantom)),
  );
});
