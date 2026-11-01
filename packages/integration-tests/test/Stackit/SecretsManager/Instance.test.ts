import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Billed per secret version per hour with a minimum of 50 secrets, which comes
// to under EUR 0.01 per run, so the lifecycle runs ungated. Names are generated
// by the engine and are stable per stack/stage.
const options = { tags: stackitTags("secretsmanager", "instance"), timeout: 300_000 } as const;

/**
 * Whether the project still lists the instance. A list, because Terraform's
 * provider saw a 403 rather than a 404 from a `get` on a deleted instance.
 */
const isListed = (projectId: string, instanceId: string) =>
  secretsManager
    .listInstances({ projectId })
    .pipe(Effect.map(({ instances }) => instances.some((instance) => instance.id === instanceId)));

const waitUntilUnlisted = (projectId: string, instanceId: string) =>
  isListed(projectId, instanceId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (listed) => !listed,
      times: 20,
    }),
  );

const liveAcls = (projectId: string, instanceId: string) =>
  secretsManager
    .listACLs({ projectId, instanceId })
    .pipe(Effect.map(({ acls }) => acls.map((acl) => acl.cidr).sort()));

test.provider(
  "create, update and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.SecretsManager.Instance("BasicInstance", {
          acls: ["198.51.100.0/24", "203.0.113.0/24"],
        }),
      );

      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.name).toMatch(/^[a-z0-9-]+$/);
      expect(created.apiUrl).toMatch(/^https:\/\//);
      expect(created.creationFinishedDate).toEqual(expect.any(String));
      expect([...created.acls].sort()).toEqual(["198.51.100.0/24", "203.0.113.0/24"]);

      // Out of band: the instance exists with the ACL entries.
      const fetched = yield* secretsManager.getInstance({
        projectId,
        instanceId: created.instanceId,
      });
      expect(fetched.name).toEqual(created.name);
      expect(yield* liveAcls(projectId, created.instanceId)).toEqual([
        "198.51.100.0/24",
        "203.0.113.0/24",
      ]);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(
        Stackit.SecretsManager.Instance("BasicInstance", {
          acls: ["198.51.100.0/24", "203.0.113.0/24"],
        }),
      );
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // An update renames it, and swaps one ACL entry while keeping the other.
      const updated = yield* stack.deploy(
        Stackit.SecretsManager.Instance("BasicInstance", {
          name: "alchemy-test-instance-renamed",
          acls: ["203.0.113.0/24", "192.0.2.0/24"],
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.name).toEqual("alchemy-test-instance-renamed");

      const renamed = yield* secretsManager.getInstance({
        projectId,
        instanceId: created.instanceId,
      });
      expect(renamed.name).toEqual("alchemy-test-instance-renamed");
      expect(yield* liveAcls(projectId, created.instanceId)).toEqual([
        "192.0.2.0/24",
        "203.0.113.0/24",
      ]);

      // Omitting `acls` leaves the live list alone.
      yield* stack.deploy(
        Stackit.SecretsManager.Instance("BasicInstance", {
          name: "alchemy-test-instance-renamed-2",
        }),
      );
      expect(yield* liveAcls(projectId, created.instanceId)).toEqual([
        "192.0.2.0/24",
        "203.0.113.0/24",
      ]);

      // An empty list removes every entry.
      yield* stack.deploy(
        Stackit.SecretsManager.Instance("BasicInstance", {
          name: "alchemy-test-instance-renamed-2",
          acls: [],
        }),
      );
      expect(yield* liveAcls(projectId, created.instanceId)).toEqual([]);

      yield* stack.destroy();

      expect(yield* waitUntilUnlisted(projectId, created.instanceId)).toEqual(false);
    }).pipe(logLevel),
  options,
);

test.provider(
  "an instance with an explicit name and no state is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-test-foreign-instance";
      const foreign = yield* secretsManager.createInstance({ projectId, name });

      const exit = yield* stack
        .deploy(Stackit.SecretsManager.Instance("ForeignInstance", { name }))
        .pipe(Effect.exit);
      expect(exit._tag).toEqual("Failure");

      // The foreign instance was neither taken over nor removed.
      expect(yield* isListed(projectId, foreign.id)).toEqual(true);

      yield* secretsManager.deleteInstance({ projectId, instanceId: foreign.id });
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
