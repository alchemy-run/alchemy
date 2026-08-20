/**
 * Forcing a subset of the stack.
 *
 * Two independent selectors, resolved in `Plan.make`:
 *
 *   - the RUN selection (`--force`, `--force=Seed,Api`) — `MakePlanOptions.force`
 *   - the DECLARATION policy (`.pipe(force(...))`) — captured on the
 *     resource/action at registration and authoritative over the run selection,
 *     so `force(false)` is a real opt-out of a blanket `--force`.
 *
 * Forcing only ever upgrades a `noop` to an `update` (resources) or a `run`
 * (actions); it never changes a create/replace/delete decision.
 */
import { Action } from "@/Action";
import { apply } from "@/Apply";
import { provideFreshArtifactStore } from "@/Artifacts";
import { force } from "@/ForcePolicy";
import * as Namespace from "@/Namespace";
import * as Plan from "@/Plan";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { InMemoryService, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { TestLayers, TestResource } from "./test.resources.ts";

const { test } = Test.make({
  providers: TestLayers(),
  state: Layer.effect(
    State,
    Effect.sync(() => InMemoryService({})),
  ),
});

const STAGE = "test";

const makeHarness = (name: string) => {
  const store: Record<string, Record<string, Record<string, any>>> = {};
  const stateLayer = Layer.effect(
    State,
    Effect.sync(() => InMemoryService(store)),
  );
  const compile = (effect: Effect.Effect<any, any, any>) =>
    (effect as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name,
        providers: TestLayers() as Layer.Layer<any, never, any>,
        state: stateLayer,
      }),
    );
  const run = (
    effect: Effect.Effect<any, any, any>,
    options: Plan.MakePlanOptions | undefined,
    then: (plan: any) => Effect.Effect<any, any, any>,
  ) =>
    compile(effect).pipe(
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled, options).pipe(
          Effect.flatMap(then),
          Effect.provide(compiled.services),
        ),
      ),
      Effect.provide(Layer.succeed(Stage, STAGE)),
      provideFreshArtifactStore,
    ) as unknown as Effect.Effect<any, any, never>;

  return {
    deploy: (
      effect: Effect.Effect<any, any, any>,
      options?: Plan.MakePlanOptions,
    ) => run(effect, options, apply),
    plan: (
      effect: Effect.Effect<any, any, any>,
      options?: Plan.MakePlanOptions,
    ) => run(effect, options, Effect.succeed),
  };
};

describe("run-level force selection", () => {
  test(
    "--force=<id> forces only the named resource",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-one");
      const program = Effect.gen(function* () {
        yield* TestResource("Api", { string: "api" });
        yield* TestResource("Seed", { string: "seed" });
      });

      yield* deploy(program);

      const unforced: any = yield* plan(program);
      expect(unforced.resources.Api.action).toBe("noop");
      expect(unforced.resources.Seed.action).toBe("noop");

      const forced: any = yield* plan(program, { force: ["Seed"] });
      expect(forced.resources.Seed.action).toBe("update");
      expect(forced.resources.Api.action).toBe("noop");
    }),
  );

  test(
    "a selection entry matches either the logical ID or the FQN",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-fqn");
      const program = Namespace.push(
        "Backend",
        Effect.gen(function* () {
          yield* TestResource("Api", { string: "api" });
          yield* TestResource("Seed", { string: "seed" });
        }),
      );

      yield* deploy(program);

      const byFqn: any = yield* plan(program, { force: ["Backend/Seed"] });
      expect(byFqn.resources["Backend/Seed"].action).toBe("update");
      expect(byFqn.resources["Backend/Api"].action).toBe("noop");

      const byLogicalId: any = yield* plan(program, { force: ["Seed"] });
      expect(byLogicalId.resources["Backend/Seed"].action).toBe("update");
      expect(byLogicalId.resources["Backend/Api"].action).toBe("noop");
    }),
  );

  test(
    "--force=<unknown> dies instead of silently forcing nothing",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-typo");
      const program = Effect.gen(function* () {
        yield* TestResource("Api", { string: "api" });
      });
      yield* deploy(program);

      const exit = yield* Effect.exit(plan(program, { force: ["Ap"] }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause) as any;
        expect(err._tag).toBe("UnknownForceTarget");
        expect(err.targets).toEqual(["Ap"]);
        expect(err.available).toEqual(["Api"]);
        expect(err.message).toContain("Available: Api");
      }
    }),
  );

  test(
    "an empty selection forces nothing",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-empty");
      const program = Effect.gen(function* () {
        yield* TestResource("Api", { string: "api" });
      });
      yield* deploy(program);

      const p: any = yield* plan(program, { force: [] });
      expect(p.resources.Api.action).toBe("noop");
    }),
  );

  test(
    "--force=<id> re-runs only the named action",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-action-selection");
      const Seed = Action("Seed", (_: { table: string }) =>
        Effect.succeed({ rows: 1 }),
      );
      const Report = Action("Report", (_: { table: string }) =>
        Effect.succeed({ rows: 2 }),
      );
      const program = Effect.gen(function* () {
        yield* Seed({ table: "users" });
        yield* Report({ table: "users" });
      });

      yield* deploy(program);

      const unforced: any = yield* plan(program);
      expect(unforced.actions.Seed.action).toBe("noop");

      const forced: any = yield* plan(program, { force: ["Seed"] });
      expect(forced.actions.Seed.action).toBe("run");
      expect(forced.actions.Seed.forced).toBe(true);
      expect(forced.actions.Report.action).toBe("noop");
    }),
  );
});

describe("force() decoration", () => {
  test(
    "force(true) on a declaration forces it with no CLI flag at all",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-decoration");
      const program = Effect.gen(function* () {
        yield* TestResource("Api", { string: "api" });
        yield* TestResource("Seed", { string: "seed" }).pipe(force(true));
      });

      yield* deploy(program);

      const p: any = yield* plan(program);
      expect(p.resources.Seed.action).toBe("update");
      expect(p.resources.Api.action).toBe("noop");
    }),
  );

  test(
    "force(false) opts out of a blanket --force",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-optout");
      const program = Effect.gen(function* () {
        yield* TestResource("Api", { string: "api" });
        yield* TestResource("Pinned", { string: "pinned" }).pipe(force(false));
      });

      yield* deploy(program);

      const p: any = yield* plan(program, { force: true });
      expect(p.resources.Api.action).toBe("update");
      expect(p.resources.Pinned.action).toBe("noop");
    }),
  );

  test(
    "force() decorates a whole scope",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-scope");
      const program = Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("Seed", { string: "seed" });
          yield* TestResource("Migrate", { string: "migrate" });
        }).pipe(force(true));
        yield* TestResource("Api", { string: "api" });
      });

      yield* deploy(program);

      const p: any = yield* plan(program);
      expect(p.resources.Seed.action).toBe("update");
      expect(p.resources.Migrate.action).toBe("update");
      expect(p.resources.Api.action).toBe("noop");
    }),
  );

  test(
    "force(true) on an action re-runs its body against an unchanged input",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-action-decoration");
      let runs = 0;
      const Seed = Action("Seed", (_: { table: string }) =>
        Effect.sync(() => ({ rows: ++runs })),
      );
      const program = Effect.gen(function* () {
        yield* Seed({ table: "users" }).pipe(force(true));
      });

      yield* deploy(program);
      expect(runs).toBe(1);

      const p: any = yield* plan(program);
      expect(p.actions.Seed.action).toBe("run");
      expect(p.actions.Seed.forced).toBe(true);

      yield* deploy(program);
      expect(runs).toBe(2);
    }),
  );

  test(
    "an undecorated action still noops on an unchanged input (control)",
    Effect.gen(function* () {
      const { deploy } = makeHarness("force-action-control");
      let runs = 0;
      const Seed = Action("Seed", (_: { table: string }) =>
        Effect.sync(() => ({ rows: ++runs })),
      );
      const program = Effect.gen(function* () {
        yield* Seed({ table: "users" });
      });

      yield* deploy(program);
      yield* deploy(program);
      expect(runs).toBe(1);
    }),
  );
});
