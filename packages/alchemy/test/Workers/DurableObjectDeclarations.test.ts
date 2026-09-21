import { DurableObject as CelldDurableObject } from "@/Celld/DurableObject.ts";
import { DurableObjectState as CelldState } from "@/Celld/DurableObjectState.ts";
import { DurableObject as CloudflareDurableObject } from "@/Cloudflare/Workers/DurableObject.ts";
import { DurableObjectState as CloudflareState } from "@/Cloudflare/Workers/DurableObjectState.ts";
import { LiteralExpr } from "@/Output.ts";
import { DurableObject as RivetDurableObject } from "@/Rivet/DurableObject.ts";
import { DurableObjectState as RivetState } from "@/Rivet/DurableObjectState.ts";
import { Self } from "@/Self.ts";
import {
  durableObjectPlanContext,
  type DurableObjectExport,
  type DurableObjectHostLike,
} from "@/Workers/DurableObject.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

class Dependency extends Context.Service<Dependency, string>()(
  "DeclarationDependency",
) {}
interface Shape {
  value(): Effect.Effect<string>;
}
class CloudflareCounter extends CloudflareDurableObject<
  CloudflareCounter,
  Shape
>()("Counter") {}
class CelldCounter extends CelldDurableObject<CelldCounter, Shape>()(
  "Counter",
) {}
class RivetCounter extends RivetDurableObject<RivetCounter, Shape>()(
  "Counter",
) {}

type Constructor = Effect.Effect<Effect.Effect<Shape>, never, any>;
const providers: ReadonlyArray<{
  type: string;
  state: Context.Service<any, any>;
  build(impl: Constructor): Effect.Effect<
    {
      readonly name: string;
      getByName(name: string): unknown;
    },
    never,
    any
  >;
}> = [
  {
    type: "Cloudflare.Worker",
    state: CloudflareState,
    build: (impl) =>
      CloudflareCounter.pipe(Effect.provide(CloudflareCounter.make(impl))),
  },
  {
    type: "Celld.Worker",
    state: CelldState,
    build: (impl) => CelldCounter.pipe(Effect.provide(CelldCounter.make(impl))),
  },
  {
    type: "Rivet.Worker",
    state: RivetState,
    build: (impl) => RivetCounter.pipe(Effect.provide(RivetCounter.make(impl))),
  },
];

const makeHost = (Type: string) => {
  const bindings: unknown[] = [];
  const exports = new Map<string, DurableObjectExport>();
  const host: DurableObjectHostLike & {
    durableObjectNamespaces: LiteralExpr<Record<string, string>>;
  } = {
    Type,
    LogicalId: "Host",
    durableObjectNamespaces: new LiteralExpr<Record<string, string>>({}),
    bind: () => (binding) =>
      Effect.sync(() => {
        bindings.push(binding);
      }),
    export: (name, value) =>
      Effect.sync(() => {
        exports.set(name, value);
      }),
    durableObjectBinding: (declaration) => declaration,
    durableObjectStub: (stub) => stub,
  };
  return { host, bindings, exports };
};

const inPlan = <A, E>(
  effect: Effect.Effect<A, E, any>,
  host: DurableObjectHostLike,
) => {
  const context: Context.Context<any> = Context.make(Self, host).pipe(
    Context.add(Dependency, "captured"),
    Context.add(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "plan" }),
    ),
  );
  return effect.pipe(Effect.provide(context));
};

describe("provider-owned Durable Object declarations", () => {
  for (const provider of providers) {
    it.effect(
      `${provider.type} supplies only its plan state and captures application services`,
      () =>
        Effect.gen(function* () {
          const { host, bindings, exports } = makeHost(provider.type);
          let initialized = 0;
          let constructed = 0;
          const tag: Context.Service<any, any> = provider.state;
          const impl = Effect.gen(function* () {
            yield* tag;
            const value = yield* Dependency;
            initialized++;
            for (const other of providers) {
              const stateTag: Context.Service<any, any> = other.state;
              const state = yield* Effect.serviceOption(stateTag);
              expect(Option.isSome(state)).toBe(other.type === provider.type);
            }
            return Effect.sync(() => {
              constructed++;
              return { value: () => Effect.succeed(value) };
            });
          });
          const namespace = yield* inPlan(provider.build(impl), host);
          expect(namespace.name).toBe("Counter");
          expect(initialized).toBe(1);
          expect(constructed).toBe(0);
          expect(bindings).toHaveLength(1);
          expect(exports.size).toBe(1);
          const exported = exports.get("Counter")!;
          expect(exported.provider).toBe(provider.type);
          expect(
            Context.get(
              exported.services as Context.Context<Dependency>,
              Dependency,
            ),
          ).toBe("captured");
          expect(() => namespace.getByName("counter")).toThrow(
            "only be called at runtime",
          );
        }),
    );

    it.effect(
      `${provider.type} permits deferred storage effects during planning`,
      () =>
        Effect.gen(function* () {
          const { host, exports } = makeHost(provider.type);
          const impl = Effect.gen(function* () {
            const state = yield* provider.state;
            const read: Effect.Effect<string> = state.storage.get("count");
            return read.pipe(
              Effect.map((value) => ({ value: () => Effect.succeed(value) })),
            );
          });
          yield* inPlan(provider.build(impl), host);
          expect(exports.size).toBe(1);
          const inner = yield* impl.pipe(
            Effect.provide(durableObjectPlanContext(provider.state)),
          );
          const result = yield* Effect.exit(inner);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(Cause.pretty(result.cause)).toContain(
              "storage.get can only be called at runtime",
            );
          }
        }),
    );

    it.effect(
      `${provider.type} rejects an unrelated hosting provider before registration`,
      () =>
        Effect.gen(function* () {
          const wrong = providers.find(
            (other) => other.type !== provider.type,
          )!;
          const { host, bindings, exports } = makeHost(wrong.type);
          const declaration = provider.build(
            Effect.succeed(
              Effect.succeed({ value: () => Effect.succeed("value") }),
            ),
          );
          const result = yield* inPlan(Effect.exit(declaration), host);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(Cause.pretty(result.cause)).toContain(
              `requires a ${provider.type} host`,
            );
          }
          expect(bindings).toHaveLength(0);
          expect(exports.size).toBe(0);
        }),
    );
  }

  it.effect(
    "Rivet inline declarations register their provider and preserve application services",
    () =>
      Effect.gen(function* () {
        const { host, exports } = makeHost("Rivet.Worker");
        class Inline extends RivetDurableObject<Inline>()(
          "Inline",
          Effect.gen(function* () {
            yield* RivetState;
            const value = yield* Dependency;
            return Effect.succeed({ value: () => Effect.succeed(value) });
          }),
        ) {}
        yield* inPlan(Inline, host);
        expect(exports.get("Inline")?.provider).toBe("Rivet.Worker");
      }),
  );

  it.effect("direct Celld declarations normalize a single init effect", () =>
    Effect.gen(function* () {
      const { host, exports } = makeHost("Celld.Worker");
      const declaration = CelldDurableObject(
        "Direct",
        Effect.gen(function* () {
          yield* CelldState;
          const value = yield* Dependency;
          return { value: () => Effect.succeed(value) };
        }),
      );
      yield* inPlan(declaration, host);
      const exported = exports.get("Direct")! as DurableObjectExport<Shape>;
      const constructor = yield* exported.constructor.pipe(
        Effect.provide(
          Context.merge(
            exported.services,
            durableObjectPlanContext(CelldState),
          ) as Context.Context<any>,
        ),
      );
      const shape = yield* constructor.pipe(
        Effect.provide(Context.empty() as Context.Context<any>),
      );
      expect(yield* shape.value()).toBe("captured");
    }),
  );

  it.effect(
    "Rivet plans deferred native-context lookup without executing it",
    () =>
      Effect.gen(function* () {
        const { host, exports } = makeHost("Rivet.Worker");
        const impl = Effect.gen(function* () {
          const state = yield* RivetState;
          return state.raw.pipe(
            Effect.as({ value: () => Effect.succeed("native") }),
          );
        });
        yield* inPlan(
          RivetCounter.pipe(Effect.provide(RivetCounter.make(impl))),
          host,
        );
        expect(exports.size).toBe(1);
        const context = durableObjectPlanContext(RivetState, ["raw"]);
        const deferred = Context.get(context, RivetState).raw.pipe(
          Effect.as("native"),
        );
        const result = yield* deferred.pipe(
          Effect.provide(Context.empty() as Context.Context<any>),
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(Cause.pretty(result.cause)).toContain(
            "raw can only be called at runtime",
          );
        }
      }),
  );

  it("plan state rejects imperative native operations", () => {
    const state = Context.get(durableObjectPlanContext(CelldState), CelldState);
    expect(() => state.raw.storage.get("key")).toThrow(
      "can only be called at runtime",
    );
    expect(() => state.storage.kv.get("key")).toThrow(
      "can only be called at runtime",
    );
  });
});
