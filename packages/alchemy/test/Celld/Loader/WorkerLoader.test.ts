import {
  WorkerLoader,
  fromNativeWorkerLoader,
  type NativeDurableObjectClass,
  type NativeLoadedWorker,
  type NativeWorkerLoader,
  type WorkerLoaderModule,
  type WorkerLoaderWorkerCode,
} from "@/Celld/WorkerLoader.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const code: WorkerLoaderWorkerCode = {
  compatibilityDate: "2026-09-01",
  mainModule: "main.js",
  modules: { "main.js": "export default {}" },
  globalOutbound: null,
};
type Assert<T extends true> = T;
export type WorkerLoaderCodeContract = [
  Assert<
    {} extends Pick<WorkerLoaderWorkerCode, "compatibilityDate"> ? false : true
  >,
  Assert<ArrayBuffer extends WorkerLoaderModule ? false : true>,
  Assert<Uint8Array extends WorkerLoaderModule ? false : true>,
  Assert<
    { wasm: Uint8Array<ArrayBuffer> } extends WorkerLoaderModule ? true : false
  >,
];

class Value extends Context.Service<Value, string>()("Loader.Test.Value") {}

const fixture = () =>
  Effect.sync(() => {
    const calls: string[] = [];
    const selections: unknown[] = [];
    const loadedCodes: WorkerLoaderWorkerCode[] = [];
    const callbacks: (() =>
      | WorkerLoaderWorkerCode
      | Promise<WorkerLoaderWorkerCode>)[] = [];
    const token = Object.freeze({}) as NativeDurableObjectClass;
    const worker: NativeLoadedWorker = {
      getEntrypoint: (name, options) => {
        calls.push("entrypoint");
        selections.push({ name, options });
        if (name === "bad") throw new TypeError("Unsupported selection");
        return {
          fetch: () =>
            Effect.runPromise(
              Effect.sync(() => {
                calls.push("fetch");
                return new Response("loaded");
              }),
            ),
          echo: (value: string) => Effect.runPromise(Effect.succeed(value)),
        };
      },
      getDurableObjectClass: (name, options) => {
        calls.push("class");
        selections.push({ name, options });
        return token;
      },
      dispose: () => {
        calls.push("dispose");
      },
    };
    const native: NativeWorkerLoader = {
      load: (code) => {
        calls.push("load");
        loadedCodes.push(code);
        return worker;
      },
      get: (name, callback) => {
        calls.push(`get:${name}`);
        callbacks.push(callback);
        return worker;
      },
    };
    return { native, calls, callbacks, selections, loadedCodes, token };
  });

describe("Celld native WorkerLoader adapter", () => {
  it("carries the generated binding marker without loading a worker", () => {
    const declaration = WorkerLoader("TOOLS");
    expect(declaration["~alchemy/Kind"]).toBe("Celld.WorkerLoader");
    expect(declaration["~alchemy/Name"]).toBe("TOOLS");
    expect(Effect.isEffect(declaration)).toBe(true);
  });

  it.effect(
    "anonymous workers dispose with the request and selectors preserve structured props",
    () =>
      Effect.gen(function* () {
        const { native, calls, selections, token } = yield* fixture();
        const loader = fromNativeWorkerLoader(() => native);
        expect(calls).toEqual([]);
        const props = yield* Effect.sync(() => new Map([["count", 1]]));
        yield* Effect.gen(function* () {
          const worker = yield* loader.load(code);
          expect("fetch" in worker).toBe(false);
          const entrypoint = yield* worker.getEntrypoint<{
            echo(value: string): Promise<string>;
          }>("Tool", { props });
          expect(yield* entrypoint.echo("hello")).toBe("hello");
          expect(
            yield* (yield* entrypoint.fetch(
              HttpClientRequest.get("https://loaded/"),
            )).text,
          ).toBe("loaded");
          expect(yield* worker.getDurableObjectClass("Facet", { props })).toBe(
            token,
          );
          const invalid = yield* Effect.result(worker.getEntrypoint("bad"));
          expect(Result.isFailure(invalid) && invalid.failure._tag).toBe(
            "Celld.WorkerLoaderError",
          );
          expect(selections[0]).toEqual({ name: "Tool", options: { props } });
        }).pipe(Effect.scoped);
        expect(calls.filter((call) => call === "dispose")).toHaveLength(1);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.effect(
    "forwards the required compatibility date and explicit Wasm module wrapper",
    () =>
      Effect.gen(function* () {
        const { native, loadedCodes, callbacks } = yield* fixture();
        const loader = fromNativeWorkerLoader(() => native);
        const wasm = yield* Effect.sync(
          () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
        );
        const source: WorkerLoaderWorkerCode = {
          ...code,
          modules: { ...code.modules, "module.wasm": { wasm } },
        };
        yield* loader.load(source).pipe(Effect.scoped);
        expect(loadedCodes[0]).toBe(source);
        expect(loadedCodes[0]!.compatibilityDate).toBe("2026-09-01");
        expect(loadedCodes[0]!.modules["module.wasm"]).toEqual({ wasm });
        yield* loader.get("wasm", () => source);
        expect(yield* Effect.sync(callbacks[0]!)).toBe(source);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.effect(
    "named getCode is lazy, preserves Effect services, and is not automatically disposed",
    () =>
      Effect.gen(function* () {
        const { native, calls, callbacks } = yield* fixture();
        const loader = fromNativeWorkerLoader(() => native);
        let evaluated = 0;
        yield* loader.get("named", () =>
          Effect.gen(function* () {
            evaluated++;
            return { ...code, env: { value: yield* Value } };
          }),
        );
        expect(evaluated).toBe(0);
        const deferred = yield* Effect.sync(callbacks[0]!);
        const resolved =
          deferred instanceof Promise
            ? yield* Effect.promise(() => deferred)
            : deferred;
        expect(resolved.env).toEqual({ value: "context survived" });
        expect(evaluated).toBe(1);
        expect(calls).toEqual(["get:named"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeContext.phantom,
            Layer.succeed(Value, "context survived"),
          ),
        ),
      ),
  );
});
