import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as edge from "@distilled.cloud/stackit/edge";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { type CreatingResourceState, State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, MISSING_INSTANCE_ID, observeInstance, planId, slow } from "./edge.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("edgecloud", "instance"),
  // A create, an update and a delete, each with a 10-minute budget, and one more of each.
  timeout: 3_600_000,
} as const;

const probeOptions = { tags: stackitTags("edgecloud", "instance"), timeout: 120_000 } as const;

// Ungated probes: they create nothing, and cost nothing. No test here has run: no STACKIT
// account exists yet. An unentitled project may answer them with an error this module doesn't
// type. The catalog's Unverified section says what to do with it.

test.provider(
  "listPlansProject returns the plans a project can use",
  (_stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      const { validPlans } = yield* edge.listPlansProject({ projectId });
      for (const plan of validPlans ?? []) {
        expect(plan.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(plan.maxEdgeHosts ?? 0).toBeGreaterThanOrEqual(plan.minEdgeHosts ?? 0);
      }
      // The list may be empty on an unentitled project. On an entitled one, it holds the plan
      // the suites create instances on.
      if (planId !== "") {
        expect((validPlans ?? []).map((plan) => plan.id)).toContain(planId);
      }
    }).pipe(logLevel),
  probeOptions,
);

test.provider(
  "a missing instance is the typed NotFound on read and delete",
  (_stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const ids = { projectId, regionId: region, instanceId: MISSING_INSTANCE_ID };
      const read = yield* edge.getInstance(ids).pipe(Effect.flip);
      expect(read._tag).toEqual("NotFound");
      const removed = yield* edge.deleteInstance(ids).pipe(Effect.flip);
      expect(removed._tag).toEqual("NotFound");
    }).pipe(logLevel),
  probeOptions,
);

test.provider(
  "createInstance rejects an invalid name with the typed BadRequest",
  (_stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      // One character is below the spec's minimum of four, so nothing can be created.
      const refused = yield* edge
        .createInstance({
          projectId,
          regionId: region,
          displayName: "x",
          planId: "00000000-0000-0000-0000-000000000000",
        })
        .pipe(Effect.flip);
      expect(refused._tag).toEqual("BadRequest");
    }).pipe(logLevel),
  probeOptions,
);

test.provider.skipIf(slow)(
  "create, update in place, recover and delete an instance with a generated name",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = { planId, description: "Alchemy test instance" };
      const created = yield* stack.deploy(Stackit.EdgeCloud.Instance("BasicInstance", props));
      expect(created.status).toEqual("active");
      expect(created.displayName).toMatch(/^a7-[a-z2-7]{5}$/);
      expect(created.planId).toEqual(planId);
      expect(created.description).toEqual(props.description);
      expect(created.frontendUrl).toMatch(/^https:\/\//);

      // Out of band: the instance exists as declared.
      const fetched = yield* edge.getInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(fetched.displayName).toEqual(created.displayName);
      expect(fetched.status).toEqual("active");
      expect(fetched.description).toEqual(props.description);

      // `list` finds it by its generated name.
      const provider = yield* Provider.findProvider(Stackit.EdgeCloud.Instance);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.instanceId === created.instanceId)?.displayName).toEqual(
        created.displayName,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.EdgeCloud.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // The description updates in place, on the same instance, and so does the plan when
      // the project has a second one.
      const { validPlans } = yield* edge.listPlansProject({ projectId });
      const nextPlanId = validPlans?.find((candidate) => candidate.id !== planId)?.id ?? planId;
      const updated = yield* stack.deploy(
        Stackit.EdgeCloud.Instance("BasicInstance", {
          planId: nextPlanId,
          description: "Updated",
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.created).toEqual(created.created);
      expect(updated.status).toEqual("active");
      const refetched = yield* edge.getInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(refetched.description).toEqual("Updated");
      expect(refetched.planId).toEqual(nextPlanId);

      // Removing the description clears it.
      const cleared = yield* stack.deploy(
        Stackit.EdgeCloud.Instance("BasicInstance", { planId: nextPlanId }),
      );
      expect(cleared.description).toBeUndefined();
      const afterClear = yield* edge.getInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(afterClear.description ?? "").toEqual("");

      // What a crash after the create call leaves: a row still creating, with its
      // generation, and no copy of the id. The next deploy finds the instance by that
      // generation's name, and doesn't create a second one.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const key = { stack: stack.name, stage: stack.stage, fqn: "BasicInstance" };
        const row = yield* state.get(key);
        if (row?.status !== "created") {
          return yield* Effect.fail(new Error("Expected a created row"));
        }
        const { attr: _attr, ...rest } = row;
        yield* state.set({
          ...key,
          value: { ...rest, status: "creating" } satisfies CreatingResourceState,
        });
      }).pipe(Effect.provide(stack.state));
      const recovered = yield* stack.deploy(
        Stackit.EdgeCloud.Instance("BasicInstance", { planId: nextPlanId }),
      );
      expect(recovered.instanceId).toEqual(created.instanceId);
      const { instances } = yield* edge.listInstances({ projectId, regionId: region });
      expect(instances.filter((entry) => entry.displayName === created.displayName)).toHaveLength(
        1,
      );

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, created.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "renaming replaces an instance, and removing the name keeps it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.EdgeCloud.Instance("NamedInstance", { displayName: "alc-ren1", planId }),
      );
      expect(first.displayName).toEqual("alc-ren1");

      const renamed = yield* stack.deploy(
        Stackit.EdgeCloud.Instance("NamedInstance", { displayName: "alc-ren2", planId }),
      );
      expect(renamed.displayName).toEqual("alc-ren2");
      expect(renamed.instanceId).not.toEqual(first.instanceId);
      yield* expectGone(observeInstance(projectId, region, first.instanceId));

      // Without a name it keeps the one it has: a new name would be a new instance.
      const unnamed = yield* stack.deploy(Stackit.EdgeCloud.Instance("NamedInstance", { planId }));
      expect(unnamed.instanceId).toEqual(renamed.instanceId);
      expect(unnamed.displayName).toEqual("alc-ren2");

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, renamed.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an instance with an explicit name and no state is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const displayName = "alc-frgn";
      const ids = { projectId, regionId: region };
      // This API has no labels, so `pnpm nuke` can't find it by anything but a generated name.
      // It goes whatever the assertions do.
      yield* Effect.acquireUseRelease(
        edge.createInstance({ ...ids, displayName, planId }),
        (foreign) =>
          Effect.gen(function* () {
            const instance = Stackit.EdgeCloud.Instance("ForeignInstance", {
              displayName,
              planId,
            });
            const refused = yield* stack.deploy(instance).pipe(Effect.flip);
            expect(refused._tag).toEqual("OwnedBySomeoneElse");
            const stillThere = yield* observeInstance(projectId, region, foreign.id);
            expect(stillThere).not.toEqual("gone");

            const adopted = yield* stack.deploy(instance.pipe(adopt(true)));
            expect(adopted.instanceId).toEqual(foreign.id);
            expect(adopted.status).toEqual("active");

            const plan = yield* stack.plan(instance.pipe(adopt(true)));
            expect(plan.resources.ForeignInstance).toMatchObject({ action: "noop" });

            yield* stack.destroy();
            yield* expectGone(observeInstance(projectId, region, foreign.id));
          }),
        (foreign) => edge.deleteInstance({ ...ids, instanceId: foreign.id }).pipe(Effect.ignore),
      );
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an instance recreated under the same id isn't taken over or deleted",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const displayName = "alc-reus";
      const ids = { projectId, regionId: region };
      const props = { displayName, planId };
      const ours = yield* stack.deploy(Stackit.EdgeCloud.Instance("ReusedInstance", props));

      // Out of band: the instance goes, and someone else takes its name, and so its id.
      yield* edge.deleteInstance({ ...ids, instanceId: ours.instanceId });
      yield* expectGone(observeInstance(projectId, region, ours.instanceId));
      yield* Effect.acquireUseRelease(
        edge.createInstance({ ...ids, displayName, planId }),
        (foreign) =>
          Effect.gen(function* () {
            expect(foreign.id).toEqual(ours.instanceId);

            const refused = yield* stack
              .deploy(
                Stackit.EdgeCloud.Instance("ReusedInstance", {
                  ...props,
                  description: "Not yours",
                }),
              )
              .pipe(Effect.flip);
            expect(refused._tag).toEqual("Stackit.EdgeCloud.InstanceNameTaken");

            // Destroying forgets the instance state recorded, and leaves this one.
            yield* stack.destroy();
            const still = yield* observeInstance(projectId, region, foreign.id);
            expect(still).not.toEqual("gone");
          }),
        (foreign) =>
          edge
            .deleteInstance({ ...ids, instanceId: foreign.id })
            .pipe(
              Effect.andThen(expectGone(observeInstance(projectId, region, foreign.id))),
              Effect.ignore,
            ),
      );
    }).pipe(logLevel),
  options,
);
