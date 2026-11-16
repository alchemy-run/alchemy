import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { checkActorOptions } from "@alchemy.run/rivet/DurableObject";
import { durableObjectsPlugin } from "@alchemy.run/rivet/internal/PoolHost";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { planCluster } from "./fixtures/plan-cluster.ts";
import { Plain, Tuned } from "./fixtures/pool-plan.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "RivetActorOptionsPlan", import.meta.url);

const Cluster = planCluster({
  endpoint: "http://localhost:6420",
  network: { kind: "docker", name: "rivet" },
});

/** What the pool's classes bound onto it, in a plan of `object` alone. */
const planned = (object: Effect.Effect<unknown, never, any>) =>
  Effect.gen(function* () {
    const plan = yield* stack.plan(Effect.asVoid(object).pipe(Effect.provide(Cluster)));
    const nodes = Object.values(plan.resources) as Array<{
      resource: { Type: string };
      bindings: Array<{ data: { durableObjects?: Array<Record<string, unknown>> } }>;
    }>;
    const pool = nodes.find((node) => node.resource.Type === "Rivet.Pool");
    return pool?.bindings.flatMap((binding) => binding.data.durableObjects ?? []);
  });

const invalid = (options: unknown) =>
  checkActorOptions("Room", options).pipe(
    Effect.exit,
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : new Error("the options were accepted"),
    ),
  );

describe("Rivet.DurableObject actorOptions", { tags: ["unit", "provider:rivet"] }, () => {
  it.effect("accepts the supported options, and drops unset ones", () =>
    Effect.gen(function* () {
      expect(yield* checkActorOptions("Room", undefined)).toBeUndefined();
      expect(yield* checkActorOptions("Room", {})).toBeUndefined();
      expect(yield* checkActorOptions("Room", { sleepTimeout: undefined })).toBeUndefined();
      expect(
        yield* checkActorOptions("Room", {
          sleepTimeout: 60_000,
          sleepGracePeriod: 30_000,
          onMigrateTimeout: 45_000,
          actionTimeout: undefined,
        }),
      ).toEqual({ sleepTimeout: 60_000, sleepGracePeriod: 30_000, onMigrateTimeout: 45_000 });
    }),
  );

  it.effect("rejects an option it doesn't support, and a value RivetKit would reject", () =>
    Effect.gen(function* () {
      const unsupported = yield* invalid({ canHibernateWebSocket: true });
      expect(unsupported).toMatchObject({ _tag: "Rivet.InvalidActorOptions" });
      expect((unsupported as Error).message).toContain(
        "'canHibernateWebSocket' is not one of sleepTimeout, sleepGracePeriod, onMigrateTimeout",
      );
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) {
        expect(yield* invalid({ sleepGracePeriod: value })).toMatchObject({
          _tag: "Rivet.InvalidActorOptions",
        });
      }
      expect(yield* invalid(Output.literal({ sleepTimeout: 1000 }))).toMatchObject({
        _tag: "Rivet.InvalidActorOptions",
      });
      expect(yield* invalid(30_000)).toMatchObject({ _tag: "Rivet.InvalidActorOptions" });
    }),
  );

  it("a node's classes module exports the options the pool recorded, by class", () => {
    const load = (objects: Parameters<typeof durableObjectsPlugin>[0]) =>
      durableObjectsPlugin(objects)[0]!.load("\0virtual:rivet-durable-objects");
    expect(load([{ name: "Plain", module: "/app/plain.ts", handler: "default" }])).toBe(
      [
        `import { default as d0 } from "/app/plain.ts";`,
        `export default [d0];`,
        `export const options = {};`,
      ].join("\n"),
    );
    expect(
      load([
        { name: "Plain", module: "/app/plain.ts", handler: "default" },
        {
          name: "Tuned",
          module: "/app/tuned.ts",
          handler: "Tuned",
          options: { sleepGracePeriod: 30_000 },
        },
      ]),
    ).toContain(`export const options = {"Tuned":{"sleepGracePeriod":30000}};`);
  });
});

describe("Rivet pool actorOptions", { tags: ["unit", "provider:rivet"] }, () => {
  test(
    "a class binds its actor options onto its pool",
    Effect.gen(function* () {
      expect(yield* planned(Tuned)).toEqual([
        {
          name: "Tuned",
          module: expect.stringContaining("pool-plan.ts"),
          handler: "Tuned",
          options: { sleepTimeout: 60_000, sleepGracePeriod: 30_000 },
        },
      ]);
    }),
    { timeout: 60_000 },
  );

  test(
    "a class that sets none binds what it always has",
    Effect.gen(function* () {
      const [plain] = (yield* planned(Plain)) ?? [];
      expect(plain).toEqual({
        name: "Plain",
        module: expect.stringContaining("pool-plan.ts"),
        handler: "Plain",
      });
      expect(Object.keys(plain ?? {})).toEqual(["name", "module", "handler"]);
    }),
    { timeout: 60_000 },
  );
});
