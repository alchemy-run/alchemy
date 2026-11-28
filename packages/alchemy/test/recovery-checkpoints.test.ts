import { assert, describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { Unowned } from "@/AdoptPolicy";
import { isResolved } from "@/Diff";
import * as Provider from "@/Provider";
import { Resource } from "@/Resource";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import { TestLayers, TestResource } from "./test.resources.ts";

describe("recoverable lifecycle checkpoints", { tags: ["unit", "local"] }, () => {
  interface Scoped extends Resource<
    "Test.CheckpointScoped",
    { name: string; namespace?: string; revision: number },
    { key: string; generation: string },
    { self: string }
  > {}
  const Scoped = Resource<Scoped>("Test.CheckpointScoped");
  type Phase = "precreate" | "reconcile";
  class Interrupted extends Data.TaggedError("CheckpointWriteInterrupted")<{ phase: Phase }> {}
  class Cloud extends Context.Service<
    Cloud,
    {
      resources: Map<string, { owner: string; generation: string }>;
      events: string[];
      failure: Phase | undefined;
    }
  >()("CheckpointCloud") {}
  const keyOf = (props: { name?: unknown; namespace?: unknown } = {}) =>
    `${typeof props.namespace === "string" ? props.namespace : "account"}/${props.name}`;
  const providers = Provider.succeed(Scoped, {
    diff: Effect.fn(function* ({ news = {}, olds }) {
      if (
        ("revision" in news &&
          typeof news.revision === "number" &&
          news.revision !== olds?.revision) ||
        ("namespace" in news && isResolved(news.namespace) && news.namespace !== olds?.namespace)
      ) {
        return { action: "replace" };
      }
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const cloud = yield* Cloud;
      const key = output?.key ?? keyOf(olds);
      cloud.events.push(`read ${key}`);
      const stored = cloud.resources.get(key);
      if (!stored) return undefined;
      const attributes = { key, generation: stored.generation };
      return stored.owner === id ? attributes : Unowned(attributes);
    }),
    precreate: Effect.fn(function* ({ id, news, instanceId }) {
      const cloud = yield* Cloud;
      if (!isResolved(news.namespace)) return yield* new Interrupted({ phase: "precreate" });
      const key = keyOf(news);
      cloud.resources.set(key, { owner: id, generation: instanceId });
      cloud.events.push(`precreate ${key}`);
      if (cloud.failure === "precreate" && key === "new/api")
        return yield* new Interrupted({ phase: "precreate" });
      return { key, generation: instanceId };
    }),
    reconcile: Effect.fn(function* ({ id, news, instanceId, output }) {
      const cloud = yield* Cloud;
      const key = output?.key ?? keyOf(news);
      cloud.resources.set(key, { owner: id, generation: instanceId });
      cloud.events.push(`reconcile ${key}`);
      if (cloud.failure === "reconcile" && key === "new/api")
        return yield* new Interrupted({ phase: "reconcile" });
      return { key, generation: instanceId };
    }),
    delete: Effect.fn(function* ({ output }) {
      const cloud = yield* Cloud;
      cloud.events.push(`delete ${output.key}`);
      cloud.resources.delete(output.key);
    }),
  }).pipe(
    Layer.provideMerge(
      Layer.sync(Cloud, () => ({
        resources: new Map(),
        events: [],
        failure: undefined,
      })),
    ),
  );
  const { test } = Test.make({ providers: Layer.mergeAll(providers, TestLayers()) });
  const getState = Effect.gen(function* () {
    const state = yield* yield* State;
    const stack = yield* Stack;
    return (yield* state.get({
      stack: stack.name,
      stage: stack.stage,
      fqn: "Subject",
    })) as ResourceState;
  });
  const program = (namespace: string, revision: number, cycle: boolean) =>
    Effect.gen(function* () {
      const tenant = yield* TestResource("Tenant", { string: namespace });
      const subject = yield* Scoped("Subject", { name: "api", namespace: tenant.string, revision });
      if (cycle) yield* subject.bind("Self", { self: subject.key });
      return subject;
    });

  for (const operation of ["create", "replacement"] as const) {
    test.provider(
      `retry retains ${operation} identity after precreate returns and reconcile fails`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const cloud = yield* Cloud;
          cloud.resources.clear();
          cloud.events.length = 0;
          cloud.failure = undefined;
          cloud.resources.set("account/api", { owner: "SomeoneElse", generation: "foreign" });
          if (operation === "replacement") yield* stack.deploy(program("old", 1, true));
          cloud.failure = "reconcile";
          const failed = yield* stack.deploy(program("new", 2, true)).pipe(Effect.exit);
          assert(Exit.isFailure(failed));
          const interruption = failed.cause.reasons.find(Cause.isFailReason)?.error;
          assert(interruption instanceof Interrupted);
          expect(interruption.phase).toBe("reconcile");
          const checkpoint = yield* getState;
          expect(checkpoint.props).toEqual({ name: "api", namespace: "new", revision: 2 });
          expect(checkpoint.attr).toEqual({ key: "new/api", generation: checkpoint.instanceId });
          cloud.failure = undefined;
          yield* stack.deploy(program("new", 2, true));
          const recovered = yield* getState;
          expect(recovered.instanceId).toBe(checkpoint.instanceId);
          expect(cloud.resources.get("new/api")?.generation).toBe(checkpoint.instanceId);
          yield* stack.destroy();
          expect(cloud.resources.size).toBe(1);
          expect(cloud.resources.get("account/api")).toEqual({
            owner: "SomeoneElse",
            generation: "foreign",
          });
        }),
    );
    for (const phase of ["precreate", "reconcile"] as const) {
      for (const recovery of ["retry", "destroy"] as const) {
        test.provider(
          `${recovery} recovers ${operation} after ${phase} writes but returns no attributes`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const cloud = yield* Cloud;
              cloud.resources.clear();
              cloud.events.length = 0;
              cloud.failure = undefined;
              cloud.resources.set("account/api", { owner: "SomeoneElse", generation: "foreign" });
              const cycle = phase === "precreate";
              if (operation === "replacement") yield* stack.deploy(program("old", 1, cycle));
              const previous = operation === "replacement" ? yield* getState : undefined;
              cloud.failure = phase;
              const failed = yield* stack.deploy(program("new", 2, cycle)).pipe(Effect.exit);
              assert(Exit.isFailure(failed));
              const interruption = failed.cause.reasons.find(Cause.isFailReason)?.error;
              assert(interruption instanceof Interrupted);
              expect(interruption.phase).toBe(phase);
              expect(cloud.resources.get("new/api")?.owner).toBe("Subject");
              const checkpoint = yield* getState;
              expect(checkpoint.status).toBe(
                operation === "replacement" ? "replacing" : "creating",
              );
              expect(checkpoint.attr).toBeUndefined();
              expect(checkpoint.props).toEqual({ name: "api", namespace: "new", revision: 2 });
              expect(checkpoint.propsIncomplete).toBeUndefined();
              expect(cloud.resources.get("new/api")?.generation).toBe(checkpoint.instanceId);
              if (operation === "replacement") {
                assert(checkpoint.status === "replacing");
                expect(checkpoint.old).toEqual(previous);
              }
              cloud.failure = undefined;
              cloud.events.length = 0;
              if (recovery === "retry") {
                if (operation === "replacement") {
                  cloud.failure = "reconcile";
                  const failedAgain = yield* stack
                    .deploy(program("new", 2, cycle))
                    .pipe(Effect.exit);
                  assert(Exit.isFailure(failedAgain));
                  const nextInterruption = failedAgain.cause.reasons.find(
                    Cause.isFailReason,
                  )?.error;
                  assert(nextInterruption instanceof Interrupted);
                  expect(nextInterruption.phase).toBe("reconcile");
                  const resumed = yield* getState;
                  expect(resumed.instanceId).toBe(checkpoint.instanceId);
                  assert(resumed.status === "replacing");
                  expect(resumed.old).toEqual(previous);
                  cloud.failure = undefined;
                }
                yield* stack.deploy(program("new", 2, cycle));
                const recovered = yield* getState;
                assert(recovered.attr !== undefined);
                expect(recovered.instanceId).toBe(checkpoint.instanceId);
                expect(recovered.attr.generation).toBe(checkpoint.instanceId);
                expect(cloud.resources.get("new/api")?.generation).toBe(checkpoint.instanceId);
              }
              yield* stack.destroy();
              expect(cloud.resources.has("new/api")).toBe(false);
              expect(cloud.resources.has("old/api")).toBe(false);
              expect(cloud.resources.get("account/api")).toEqual({
                owner: "SomeoneElse",
                generation: "foreign",
              });
              expect(cloud.events).not.toContain("read account/api");
              expect(cloud.events).not.toContain("delete account/api");
            }),
        );
      }
    }
  }
});
