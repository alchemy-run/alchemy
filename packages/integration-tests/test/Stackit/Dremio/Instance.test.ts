import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as dremio from "@distilled.cloud/stackit/dremio";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { type CreatingResourceState, State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CLOSED_ACL, expectGone, observeInstance, slow } from "./dremio.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("dremio", "instance"),
  timeout: 3_600_000,
} as const;

const props = {
  description: "Alchemy test instance",
  acl: CLOSED_ACL,
} satisfies Stackit.Dremio.InstanceProps;

test.provider.skipIf(slow)(
  "create, update in place, recover and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // A generated name, which fits the API's letters, digits and spaces.
      const created = yield* stack.deploy(Stackit.Dremio.Instance("BasicInstance", props));
      expect(created.state).toEqual("active");
      expect(created.displayName).toMatch(/^[a-z0-9 ]{1,32}$/);
      expect(created.description).toEqual(props.description);
      expect([...created.acl].sort()).toEqual([...CLOSED_ACL].sort());
      expect(created.authentication.type).toEqual("local-only");
      expect(created.endpoints.ui.length).toBeGreaterThan(0);
      expect(created.endpoints.catalog.length).toBeGreaterThan(0);
      expect(created.endpoints.arrowFlight.length).toBeGreaterThan(0);

      // Out of band: the instance exists as declared.
      const fetched = yield* dremio.getDremioInstance({
        projectId,
        regionId: region,
        dremioId: created.instanceId,
      });
      expect(fetched.displayName).toEqual(created.displayName);
      expect(fetched.state).toEqual("active");
      expect(fetched.description).toEqual(props.description);
      expect(fetched.authentication.type).toEqual("local-only");

      // `list` finds it by its generated name.
      const provider = yield* Provider.findProvider(Stackit.Dremio.Instance);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.instanceId === created.instanceId)?.displayName).toEqual(
        created.displayName,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Dremio.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Name, description and ACL update in place, on the same instance. Authentication
      // stays what it was: nothing here restarts Dremio.
      const updated = yield* stack.deploy(
        Stackit.Dremio.Instance("BasicInstance", {
          displayName: "Alchemy Dremio Renamed",
          description: "Updated",
          acl: ["192.0.2.2/32"],
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.state).toEqual("active");
      expect(updated.displayName).toEqual("Alchemy Dremio Renamed");
      const refetched = yield* dremio.getDremioInstance({
        projectId,
        regionId: region,
        dremioId: created.instanceId,
      });
      expect(refetched.displayName).toEqual("Alchemy Dremio Renamed");
      expect(refetched.description).toEqual("Updated");
      expect(refetched.acl).toEqual(["192.0.2.2/32"]);
      expect(refetched.authentication.type).toEqual("local-only");

      // Back to the generated name, then what a crash after the create call leaves: a row
      // still creating, with its generation, and no copy of the id. The next deploy finds
      // the instance by that generation's name, and doesn't create a second one.
      const unnamed = yield* stack.deploy(
        Stackit.Dremio.Instance("BasicInstance", {
          displayName: created.displayName,
          description: props.description,
          acl: CLOSED_ACL,
        }),
      );
      expect(unnamed.instanceId).toEqual(created.instanceId);
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
      const recovered = yield* stack.deploy(Stackit.Dremio.Instance("BasicInstance", props));
      expect(recovered.instanceId).toEqual(created.instanceId);
      const instances = yield* dremio.listDremioInstances({ projectId, regionId: region });
      expect(
        instances.dremios.filter((entry) => entry.displayName === created.displayName),
      ).toHaveLength(1);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, created.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an instance with an explicit name and no state is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const displayName = "Alchemy Dremio Foreign";
      // This API has no labels, so `pnpm nuke` can't find it by anything but a generated name.
      // It goes whatever the assertions do.
      yield* Effect.acquireUseRelease(
        dremio.createDremioInstance({
          projectId,
          regionId: region,
          displayName,
          acl: CLOSED_ACL,
          authentication: { type: "local-only" },
        }),
        (foreign) =>
          Effect.gen(function* () {
            // Reconcile waits for it to settle once it is taken over.
            const instance = Stackit.Dremio.Instance("ForeignInstance", {
              displayName,
              acl: CLOSED_ACL,
            });
            const refused = yield* stack.deploy(instance).pipe(Effect.flip);
            expect(refused._tag).toEqual("OwnedBySomeoneElse");
            const stillThere = yield* observeInstance(projectId, region, foreign.id);
            expect(stillThere).not.toEqual("gone");

            const adopted = yield* stack.deploy(instance.pipe(adopt(true)));
            expect(adopted.instanceId).toEqual(foreign.id);
            expect(adopted.state).toEqual("active");

            // Adopted, and nothing is left to do. The stack owns it now, so destroying it
            // deletes it.
            const plan = yield* stack.plan(instance.pipe(adopt(true)));
            expect(plan.resources.ForeignInstance).toMatchObject({ action: "noop" });

            yield* stack.destroy();
            yield* expectGone(observeInstance(projectId, region, foreign.id));
          }),
        (foreign) =>
          dremio
            .deleteDremioInstance({ projectId, regionId: region, dremioId: foreign.id })
            .pipe(Effect.ignore),
      );
    }).pipe(logLevel),
  options,
);
