import * as AI from "@alchemy.run/ai";
import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Binding from "alchemy/Binding";
import {
  CapabilityGraph,
  CurrentPolicy,
  makeCapabilityGraph,
  observeLayerBuilds,
  observeLookups,
  policyOf,
} from "alchemy/CapabilityGraph";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** A binding: `Store(name)` gives a client that writes. */
interface Store extends Binding.Service<
  Store,
  "Test.Store",
  (name: string) => Effect.Effect<{ readonly put: (value: string) => Effect.Effect<string> }>
> {}
const Store = Binding.Service<Store>("Test.Store");
const StoreLive = Layer.succeed(
  Store,
  Effect.fn(function* (_name: string) {
    return { put: (value: string) => Effect.succeed(`put ${value}`) };
  }),
);

const spec = {
  description: "Write a value.",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.String,
};
type Put = { readonly value: string };

/** A service whose Layer binds, for a tool that only looks it up. */
class Ledger extends Context.Service<
  Ledger,
  { readonly put: (value: string) => Effect.Effect<string> }
>()("test/Ledger") {}
const LedgerLive = Layer.effect(Ledger, Store("ledger"));

// A class, with its Layer apart.
class ByClass extends AI.Tool<ByClass>()("by_class", spec) {}
const ByClassLive = ByClass.make(
  Effect.map(
    Store("class"),
    (store) =>
      ({ value }: Put) =>
        store.put(value),
  ),
);
// A class whose Layer only looks a service up.
class ByService extends AI.Tool<ByService>()("by_service", spec) {}
const ByServiceLive = ByService.make(
  Effect.map(
    Ledger,
    (ledger) =>
      ({ value }: Put) =>
        ledger.put(value),
  ),
);
// A name only, with its schema and implementation in the Layer.
class ByTag extends AI.Tool<ByTag>()("by_tag") {}
const ByTagLive = ByTag.make(
  spec,
  Effect.map(
    Store("tag"),
    (store) =>
      ({ value }: Put) =>
        store.put(value),
  ),
);

// A class with its implementation, and no Layer.
class Inline extends AI.Tool<Inline>()(
  "inline",
  spec,
  Effect.map(
    Store("inline"),
    (store) =>
      ({ value }: Put) =>
        store.put(value),
  ),
) {}

type Handler = (parameters: Put) => Effect.Effect<string>;

/** What a runtime builds: every tool, and one client bound outside them all. */
const build = Effect.gen(function* () {
  const outer = yield* Store("outer");
  const byClass = (yield* ByClass) as unknown as Handler;
  const byService = (yield* ByService) as unknown as Handler;
  const byTag = ((yield* ByTag) as unknown as { readonly handler: Handler }).handler;
  // Built the way a harness builds a class that has its implementation.
  const inline = (yield* Inline.impl!) as unknown as Handler;
  // Closes over the client bound above.
  const closure = AI.Tool("closure", spec, ({ value }: Put) => outer.put(value));
  // A class whose Layer closes over it too.
  class Handed extends AI.Tool<Handed>()("handed", spec) {}
  const handed = (yield* Handed.pipe(
    Effect.provide(Handed.make(({ value }: Put) => outer.put(value))),
  )) as unknown as Handler;
  return {
    by_class: byClass,
    by_service: byService,
    by_tag: byTag,
    inline,
    closure: closure.handler as unknown as Handler,
    handed,
  };
}).pipe(
  Effect.provide(
    Layer.mergeAll(ByClassLive, ByServiceLive, ByTagLive).pipe(
      Layer.provide(LedgerLive),
      Layer.provideMerge(StoreLive),
    ),
  ),
);

// A Domain policy that binds where its handler is built.
class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Deposit extends Domain.Command("Deposit", {
  input: { id: Schema.String, amount: Schema.Number },
  events: [Deposited],
}) {}
class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit],
  keyOf: (command) => command.id,
  decide: { Deposit: (_, { amount }) => [new Deposited({ amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}
class Notify extends Domain.Policy("Notify", { from: Wallet, on: [Deposited] }) {}
const NotifyLive = Notify.toLayer(
  Effect.map(Store("receipts"), (store) => () => Effect.asVoid(store.put("deposited"))),
);

describe("a tool and its bindings", { tags: ["unit"] }, () => {
  it.effect("a Domain policy is a term, with what its Layer binds", () =>
    Effect.gen(function* () {
      const graph = makeCapabilityGraph();
      yield* observeLookups(graph)(
        Effect.asVoid(Notify).pipe(Effect.provide(NotifyLive.pipe(Layer.provide(StoreLive)))),
      ).pipe(
        Effect.provideService(
          Layer.CurrentMemoMap,
          observeLayerBuilds(Layer.makeMemoMapUnsafe(), graph),
        ),
        Effect.provideService(CapabilityGraph, graph),
      );
      expect(graph.describe()).toEqual([
        {
          id: "Policy:Notify",
          kind: "Policy",
          name: "Notify",
          bindings: [{ binding: "Test.Store", targets: [], via: [] }],
          references: [],
        },
      ]);
    }),
  );

  it.effect("every form of tool is listed with what it binds, and held to it", () =>
    Effect.gen(function* () {
      // The plan.
      const graph = makeCapabilityGraph();
      yield* observeLookups(graph)(build).pipe(
        Effect.provideService(
          Layer.CurrentMemoMap,
          observeLayerBuilds(Layer.makeMemoMapUnsafe(), graph),
        ),
        Effect.provideService(CapabilityGraph, graph),
      );
      const listed = Object.fromEntries(
        graph
          .describe()
          .map((node) => [node.name, node.bindings.map((each) => [each.binding, each.via])]),
      );
      expect(listed).toEqual({
        by_class: [["Test.Store", []]],
        by_service: [["Test.Store", ["test/Ledger"]]],
        by_tag: [["Test.Store", []]],
        handed: [],
        inline: [["Test.Store", []]],
      });

      // The runtime, held to that plan.
      const tools = yield* build.pipe(
        Effect.provideService(CurrentPolicy, policyOf(graph.describe())),
      );
      const outcome = Effect.fn(function* (name: keyof typeof tools) {
        const exit = yield* Effect.exit(tools[name]({ value: "x" }));
        return Exit.isSuccess(exit)
          ? exit.value
          : (Cause.squash(exit.cause) as { readonly _tag?: string })._tag;
      });
      expect({
        by_class: yield* outcome("by_class"),
        by_service: yield* outcome("by_service"),
        by_tag: yield* outcome("by_tag"),
        inline: yield* outcome("inline"),
        closure: yield* outcome("closure"),
        handed: yield* outcome("handed"),
      }).toEqual({
        by_class: "put x",
        by_service: "put x",
        by_tag: "put x",
        inline: "put x",
        closure: "CapabilityDenied",
        handed: "CapabilityDenied",
      });
    }),
  );
});
