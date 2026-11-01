import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as logs from "@distilled.cloud/stackit/logs";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CLOSED_ACL, expectGone, observeInstance } from "./logs.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("logs", "instance"), timeout: 900_000 } as const;

test.provider(
  "create, update and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        retentionDays: 7,
        description: "alchemy test instance",
        acl: [CLOSED_ACL],
        labels: { env: "test", keep: "yes" },
      };
      const created = yield* stack.deploy(Stackit.Logs.Instance("BasicLogs", props));
      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.status).toEqual("active");
      expect(created.retentionDays).toEqual(7);
      expect(created.description).toEqual("alchemy test instance");
      expect(created.acl).toEqual([CLOSED_ACL]);
      expect(created.labels).toEqual({ env: "test", keep: "yes" });
      expect(created.displayName).toMatch(/^[a-zA-Z]/);
      expect(created.displayName.length).toBeLessThanOrEqual(32);
      expect(created.datasourceUrl).toEqual(expect.stringContaining(created.instanceId));

      // Out of band: the instance has the settings and Alchemy's ownership labels.
      const fetched = yield* logs.getLogsInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(fetched.retentionDays).toEqual(7);
      expect(fetched.labels).toMatchObject({ env: "test", keep: "yes", "alchemy.id": "BasicLogs" });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Logs.Instance("BasicLogs", props));
      expect(plan.resources.BasicLogs).toMatchObject({ action: "noop" });

      // Every mutable aspect updates in place. A label removed goes, and one added comes.
      const updated = yield* stack.deploy(
        Stackit.Logs.Instance("BasicLogs", {
          displayName: "alchemy-logs-updated",
          retentionDays: 14,
          description: "alchemy test instance, updated",
          acl: [CLOSED_ACL, "192.0.2.2/32"],
          labels: { env: "prod" },
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.displayName).toEqual("alchemy-logs-updated");
      expect(updated.retentionDays).toEqual(14);
      expect(updated.acl).toHaveLength(2);
      expect(updated.labels).toEqual({ env: "prod" });

      const refetched = yield* logs.getLogsInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(refetched.displayName).toEqual("alchemy-logs-updated");
      expect(refetched.retentionDays).toEqual(14);
      expect(refetched.description).toEqual("alchemy test instance, updated");
      expect(refetched.labels).toMatchObject({ env: "prod", "alchemy.id": "BasicLogs" });
      expect(refetched.labels?.keep).toBeUndefined();

      // An update that omits `acl` and `description` leaves them alone.
      const narrowed = yield* stack.deploy(
        Stackit.Logs.Instance("BasicLogs", {
          displayName: "alchemy-logs-updated",
          retentionDays: 21,
        }),
      );
      expect(narrowed.retentionDays).toEqual(21);
      expect(narrowed.acl).toHaveLength(2);
      expect(narrowed.description).toEqual("alchemy test instance, updated");

      // Removing `retentionDays` keeps what the instance has, rather than the default for a
      // new one, which would drop older logs.
      const unset = yield* stack.deploy(
        Stackit.Logs.Instance("BasicLogs", { displayName: "alchemy-logs-renamed" }),
      );
      expect(unset.retentionDays).toEqual(21);
      const unsetLive = yield* logs.getLogsInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(unsetLive.retentionDays).toEqual(21);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, created.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "an instance with the same name and no labels is not taken over",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // It has no labels for `pnpm nuke` to find, so it goes whatever the assertions do.
      yield* Effect.acquireUseRelease(
        logs.createLogsInstance({
          projectId,
          regionId: region,
          displayName: "alchemy-logs-foreign",
          retentionDays: 1,
        }),
        (foreign) =>
          Effect.gen(function* () {
            const error = yield* stack
              .deploy(Stackit.Logs.Instance("Named", { displayName: "alchemy-logs-foreign" }))
              .pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");

            const fetched = yield* logs.getLogsInstance({
              projectId,
              regionId: region,
              instanceId: foreign.id,
            });
            expect(fetched.labels?.["alchemy.id"]).toBeUndefined();
          }),
        (foreign) =>
          logs
            .deleteLogsInstance({ projectId, regionId: region, instanceId: foreign.id })
            .pipe(
              Effect.andThen(expectGone(observeInstance(projectId, region, foreign.id))),
              Effect.ignore,
            ),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

// Two instances provision one after the other, in a region the account has to be able to
// reach. Gated on the slow flag for the time it takes, not for what it costs.
test.provider.skipIf(!process.env.STACKIT_TEST_SLOW)(
  "changing the region replaces the instance and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const other = region === "eu01" ? "eu02" : "eu01";
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.Logs.Instance("MovedLogs", { retentionDays: 1, acl: [CLOSED_ACL] }),
      );
      const second = yield* stack.deploy(
        Stackit.Logs.Instance("MovedLogs", {
          retentionDays: 1,
          acl: [CLOSED_ACL],
          region: other,
        }),
      );
      expect(second.instanceId).not.toEqual(first.instanceId);
      expect(second.region).toEqual(other);
      yield* expectGone(observeInstance(projectId, region, first.instanceId));

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, other, second.instanceId));
    }).pipe(logLevel),
  { ...options, timeout: 1_800_000 },
);
