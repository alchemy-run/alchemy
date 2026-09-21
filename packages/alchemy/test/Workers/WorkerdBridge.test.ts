import type * as cf from "@cloudflare/workers-types";
import type { DurableObject } from "cloudflare:workers";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { Telemetry } from "@/TelemetryRuntime.ts";
import type { DurableObjectExport } from "@/Workers/DurableObject.ts";
import { RpcActivationScope } from "@/Workers/RpcDurableObject.ts";
import type { WorkerBuild } from "@/Workers/Worker.ts";
import { makeDurableObjectCallbackFactory } from "@/Workers/Workerd/AlarmCallback.ts";
import { makeDurableObjectBridge } from "@/Workers/Workerd/DurableObjectBridge.ts";
import { expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

for (const fails of [false, true]) {
  it.effect(
    `native instance scope remains activation-owned (${fails ? "failed" : "successful"} construction)`,
    () =>
      Effect.gen(function* () {
        let closed = 0;
        let activation: Scope.Scope | undefined;
        let initialized: Promise<unknown> | undefined;
        const pending: Promise<unknown>[] = [];
        const state = {
          storage: {},
          blockConcurrencyWhile: (run: () => Promise<unknown>) => {
            initialized = run();
            return initialized;
          },
          waitUntil: (promise: Promise<unknown>) => {
            pending.push(promise);
          },
        } as unknown as cf.DurableObjectState;
        const runtime: RuntimeContext["Service"] = {
          Type: "test",
          id: "native-instance",
          env: {},
          get: () => Effect.succeed(undefined),
          set: (key) => Effect.succeed(key),
        };
        const build: WorkerBuild<DurableObjectExport> = {
          context: Context.make(RuntimeContext, runtime).pipe(
            Context.add(Telemetry, Layer.empty),
          ),
          export: {
            kind: "durableObject",
            provider: "test",
            services: Context.make(RuntimeContext, runtime),
            constructor: Effect.succeed(
              Effect.gen(function* () {
                activation = yield* RpcActivationScope;
                yield* Scope.addFinalizer(
                  activation,
                  Effect.sync(() => {
                    closed++;
                  }),
                );
                if (fails) return yield* Effect.die("construction failed");
                return {};
              }),
            ),
          },
          shape: () => ({}),
          telemetry: () => undefined,
        };
        const Base = class {} as unknown as typeof DurableObject;
        const Bridge = makeDurableObjectBridge(Base, {
          makeCallback: makeDurableObjectCallbackFactory,
          getExport: () => ({ build: () => Promise.resolve(build) }),
          services: () => Context.make(RuntimeContext, runtime),
        })("TestObject", { dispatch: "static" });
        const object = yield* Effect.sync(() => new Bridge(state, {}));
        const result = yield* Effect.tryPromise(() => initialized!).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(fails);
        expect(activation).toBeDefined();
        expect(closed).toBe(fails ? 1 : 0);
        if (!fails) {
          yield* Effect.promise(() =>
            object.fetch(new Request("https://test.invalid/")),
          );
          yield* Effect.forEach(
            pending,
            (promise) => Effect.promise(() => promise),
            { discard: true },
          );
          expect(closed).toBe(0);
          yield* Scope.close(activation as Scope.Closeable, Exit.void);
          expect(closed).toBe(1);
        }
      }),
  );
}
