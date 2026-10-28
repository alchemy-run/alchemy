import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Data, Layer } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { adopt, AdoptPolicy, Unowned, Unresolved } from "@/AdoptPolicy";
import { isResolved } from "@/Diff";
import * as Provider from "@/Provider";
import { Resource } from "@/Resource";
import { isResourceState, State } from "@/State";
import { TestLayers, TestResource } from "./test.resources.ts";

interface Scoped extends Resource<
  "Test.ObservedAttributes",
  { name: string; scope: string; version?: number; tag?: string },
  { name: string; scope?: string; physicalId: string },
  { self: string }
> {}
const Scoped = Resource<Scoped>("Test.ObservedAttributes");
type Attributes = Scoped["Attributes"];

class Cloud extends Context.Service<
  Cloud,
  {
    owners: Map<string, string>;
    outputs: Array<Attributes | undefined>;
    selfBindings: string[];
    failReconcile: boolean;
    fullObservation: boolean;
  }
>()("ObservedAttributesCloud") {}

class ReconcileFailure extends Data.TaggedError("ObservedAttributesReconcileFailure")<{
  message: string;
}> {
  constructor() {
    super({ message: "Interrupted before the resource write" });
  }
}

const key = (value: { name: string; scope?: unknown }) =>
  `${typeof value.scope === "string" ? value.scope : "account"}/${value.name}`;
const attributes = (value: { name: string; scope?: string }): Attributes => ({
  name: value.name,
  scope: value.scope,
  physicalId: key(value),
});

const providers = (withRead: boolean, withObserve = true) =>
  Provider.succeed(Scoped, {
    stables: ["name", "physicalId"],
    diff: Effect.fn(function* ({ olds, news }) {
      if ("scope" in news && olds.scope !== news.scope) return { action: "replace" as const };
    }),
    observe: withObserve
      ? Effect.fn(function* ({ id, news }) {
          if (!isResolved(news.scope)) return Unresolved;
          const cloud = yield* Cloud;
          const owner = cloud.owners.get(key(news));
          if (owner === undefined) return undefined;
          const observed = cloud.fullObservation ? attributes(news) : { name: news.name };
          return owner === id ? observed : Unowned(observed);
        })
      : undefined,
    read: withRead
      ? Effect.fn(function* ({ id, olds, output }) {
          const value = output ?? olds;
          const owner = (yield* Cloud).owners.get(key(value));
          if (owner === undefined) return undefined;
          const observed = attributes(value);
          return owner === id ? observed : Unowned(observed);
        })
      : undefined,
    precreate: Effect.fn(function* ({ id, news }) {
      if (!isResolved(news.scope)) return { name: news.name, physicalId: "" };
      (yield* Cloud).owners.set(key(news), id);
      return attributes(news);
    }),
    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const cloud = yield* Cloud;
      cloud.outputs.push(output);
      for (const binding of bindings) {
        const self = binding.data.self;
        if (typeof self !== "string") return yield* Effect.die("Self binding did not resolve");
        cloud.selfBindings.push(self);
      }
      if (cloud.failReconcile) return yield* new ReconcileFailure();
      const identity = output ?? news;
      cloud.owners.set(key(identity), id);
      return attributes(identity);
    }),
    delete: Effect.fn(function* ({ output }) {
      (yield* Cloud).owners.delete(key(output));
    }),
  }).pipe(
    Layer.provideMerge(
      Layer.sync(Cloud, () => ({
        owners: new Map<string, string>(),
        outputs: [],
        selfBindings: [],
        failReconcile: false,
        fullObservation: false,
      })),
    ),
  );

const { test } = Test.make({ providers: Layer.mergeAll(providers(false), TestLayers()) });
const { test: withRead } = Test.make({ providers: Layer.mergeAll(providers(true), TestLayers()) });
const { test: unchecked } = Test.make({
  providers: Layer.mergeAll(providers(false, false), TestLayers()),
});

const program = (
  scope: string,
  options: {
    cycle?: boolean;
    late?: "scope" | "tag" | "none";
    adopt?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const source = yield* TestResource("Source", { string: scope });
    const resource = yield* Scoped("Subject", {
      name: "api",
      scope: options.late === "scope" ? source.string : scope,
      tag: options.late === "tag" ? source.string : "tag",
    });
    if (options.cycle) yield* resource.bind("Self", { self: resource.name });
    return resource;
  }).pipe(adopt(options.adopt ?? false));

const reset = Effect.fn(function* (stack: Test.ScratchStack) {
  yield* stack.destroy();
  const cloud = yield* Cloud;
  cloud.owners.clear();
  cloud.owners.set("account/api", "SomeoneElse");
  cloud.outputs.length = 0;
  cloud.selfBindings.length = 0;
  cloud.failReconcile = false;
  cloud.fullObservation = false;
  return cloud;
});
const checkpoint = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const saved = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Subject" });
    if (saved !== undefined && !isResourceState(saved))
      return yield* Effect.die("Expected resource checkpoint");
    return saved;
  });

describe("observation attributes", { tags: ["unit", "local"] }, () => {
  for (const cycle of [false, true]) {
    const options = { cycle, late: cycle ? ("scope" as const) : ("none" as const) };

    test.provider(
      `partial create evidence cannot select a foreign scope (cycle=${cycle})`,
      (stack) =>
        Effect.gen(function* () {
          const cloud = yield* reset(stack);
          cloud.owners.set("tenant/api", "Subject");
          const result = yield* stack.deploy(program("tenant", options));
          expect(result.physicalId).toBe("tenant/api");
          expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
          expect(cloud.outputs[0]).toBeUndefined();
          if (cycle) expect(cloud.selfBindings).toContain("api");
          yield* stack.destroy();
          expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
        }),
    );

    test.provider(
      `failed observed create cannot delete a foreign scope (cycle=${cycle})`,
      (stack) =>
        Effect.gen(function* () {
          const cloud = yield* reset(stack);
          cloud.owners.set("tenant/api", "Subject");
          cloud.failReconcile = true;
          const error = yield* stack.deploy(program("tenant", options)).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "ObservedAttributesReconcileFailure" });
          const saved = yield* checkpoint(stack);
          yield* stack.destroy();
          expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
          expect(saved?.attr).toBeUndefined();
        }),
    );

    test.provider(`retry derives identity without partial output (cycle=${cycle})`, (stack) =>
      Effect.gen(function* () {
        const cloud = yield* reset(stack);
        cloud.owners.set("tenant/api", "Subject");
        cloud.failReconcile = true;
        yield* stack.deploy(program("tenant", options)).pipe(Effect.flip);
        cloud.failReconcile = false;
        const result = yield* stack.deploy(program("tenant", options));
        expect(result.physicalId).toBe("tenant/api");
        expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
        yield* stack.destroy();
        expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
      }),
    );

    test.provider(`replacement evidence cannot select a foreign scope (cycle=${cycle})`, (stack) =>
      Effect.gen(function* () {
        const cloud = yield* reset(stack);
        yield* stack.deploy(program("old"));
        cloud.owners.set("tenant/api", "Subject");
        cloud.outputs.length = 0;
        const result = yield* stack.deploy(program("tenant", options));
        expect(result.physicalId).toBe("tenant/api");
        expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
        expect(cloud.outputs[0]).toBeUndefined();
        expect(cloud.owners.get("old/api")).toBeUndefined();
        yield* stack.destroy();
        expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
      }),
    );
  }

  test.provider("an absent resolved target does not turn a synthetic stub into output", (stack) =>
    Effect.gen(function* () {
      const cloud = yield* reset(stack);
      const result = yield* stack.deploy(program("tenant", { cycle: true, late: "scope" }));
      expect(result.physicalId).toBe("tenant/api");
      expect(cloud.outputs[0]).toBeUndefined();
      expect(cloud.selfBindings).toContain("api");
      expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
      yield* stack.destroy();
    }),
  );

  test.provider("even complete observe-only results remain admission evidence", (stack) =>
    Effect.gen(function* () {
      const cloud = yield* reset(stack);
      cloud.owners.set("tenant/api", "Subject");
      cloud.fullObservation = true;
      cloud.failReconcile = true;
      yield* stack.deploy(program("tenant")).pipe(Effect.flip);
      expect(cloud.outputs[0]).toBeUndefined();
      expect((yield* checkpoint(stack))?.attr).toBeUndefined();
      yield* stack.destroy();
      expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
    }),
  );

  for (const cycle of [false, true]) {
    withRead.provider(
      `a complete read supplies trustworthy adoption attributes (cycle=${cycle})`,
      (stack) =>
        Effect.gen(function* () {
          const cloud = yield* reset(stack);
          cloud.owners.set("tenant/api", "Subject");
          cloud.failReconcile = true;
          const error = yield* stack
            .deploy(program("tenant", { cycle, late: "scope" }))
            .pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "ObservedAttributesReconcileFailure" });
          expect(cloud.outputs[0]).toEqual(attributes({ name: "api", scope: "tenant" }));
          expect((yield* checkpoint(stack))?.attr).toEqual(
            attributes({ name: "api", scope: "tenant" }),
          );
          yield* stack.destroy();
          expect(cloud.owners.get("tenant/api")).toBeUndefined();
          expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
        }),
    );
  }

  for (const [label, harness] of [
    ["admitted", test],
    ["unchecked", unchecked],
  ] as const) {
    harness.provider(`an ${label} physical precreate keeps its full cleanup identity`, (stack) =>
      Effect.gen(function* () {
        const cloud = yield* reset(stack);
        cloud.failReconcile = true;
        yield* stack.deploy(program("tenant", { cycle: true, late: "tag" })).pipe(Effect.flip);
        expect((yield* checkpoint(stack))?.attr).toEqual(
          attributes({ name: "api", scope: "tenant" }),
        );
        yield* stack.destroy();
        expect(cloud.owners.get("tenant/api")).toBeUndefined();
        expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
      }),
    );
  }

  test.provider("explicit adoption targets resolved props rather than partial evidence", (stack) =>
    Effect.gen(function* () {
      const cloud = yield* reset(stack);
      cloud.owners.set("tenant/api", "AnotherOwner");
      const result = yield* stack.deploy(program("tenant", { adopt: true }));
      expect(result.physicalId).toBe("tenant/api");
      expect(cloud.owners.get("tenant/api")).toBe("Subject");
      expect(cloud.owners.get("account/api")).toBe("SomeoneElse");
      yield* stack.destroy();
    }),
  );

  test.provider("scoped refusal still overrides ambient adoption", (stack) =>
    Effect.gen(function* () {
      const cloud = yield* reset(stack);
      cloud.owners.set("tenant/api", "AnotherOwner");
      const error = yield* stack.deploy(program("tenant")).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      expect(cloud.owners.get("tenant/api")).toBe("AnotherOwner");
      expect(cloud.outputs).toEqual([]);
      yield* stack.destroy();
    }).pipe(Effect.provideService(AdoptPolicy, true)),
  );
});
