import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// A fresh project needs a user among its initial members, an external identity.
const owner = process.env.STACKIT_TEST_PROJECT_OWNER;

const options = {
  tags: stackitTags("objectstorage", "project"),
  timeout: 300_000,
  // Tenant labels are one map per project.
  exclusive: "stackit:objectstorage-tenant",
} as const;

/** Out-of-band: the tenant, or `undefined` when Object Storage isn't enabled. */
const observeTenant = (projectId: string, region: string) =>
  objectStorage
    .getServiceStatus({ projectId, region })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

test.provider(
  "enable, label and release the profile project's tenant",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const tenant = (labels: Record<string, string>) =>
        Stackit.ObjectStorage.Project("Tenant", { labels });

      const created = yield* stack.deploy(
        tenant({ alchemyTestEnv: "one", alchemyTestKeep: "yes" }),
      );
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect([...created.managedLabels].sort()).toEqual(["alchemyTestEnv", "alchemyTestKeep"]);
      expect(created.disableOnDelete).toEqual(false);

      const fetched = yield* observeTenant(projectId, region);
      expect(fetched?.labels).toMatchObject({ alchemyTestEnv: "one", alchemyTestKeep: "yes" });

      // A label from outside Alchemy, which must survive every step below.
      const foreign = { ...fetched?.labels, alchemyTestForeign: "kept" };
      yield* objectStorage.updateService({ projectId, region, labels: foreign });

      const plan = yield* stack.plan(tenant({ alchemyTestEnv: "one", alchemyTestKeep: "yes" }));
      expect(plan.resources.Tenant).toMatchObject({ action: "noop" });

      // Change one label and drop another.
      const updated = yield* stack.deploy(tenant({ alchemyTestEnv: "two" }));
      expect(updated.managedLabels).toEqual(["alchemyTestEnv"]);
      expect(updated.labels.alchemyTestEnv).toEqual("two");
      expect(updated.labels.alchemyTestKeep).toBeUndefined();
      const refetched = yield* observeTenant(projectId, region);
      expect(refetched?.labels?.alchemyTestEnv).toEqual("two");
      expect(refetched?.labels?.alchemyTestKeep).toBeUndefined();
      expect(refetched?.labels?.alchemyTestForeign).toEqual("kept");

      yield* stack.destroy();

      // The tenant stays, without this resource's labels.
      const after = yield* observeTenant(projectId, region);
      expect(after?.project).toEqual(projectId);
      expect(after?.labels?.alchemyTestEnv).toBeUndefined();
      expect(after?.labels?.alchemyTestForeign).toEqual("kept");

      // Clean up the label this test added itself.
      const rest = Object.entries(after?.labels ?? {}).filter(
        ([key]) => key !== "alchemyTestForeign",
      );
      yield* objectStorage.updateService({
        projectId,
        region,
        labels: Object.fromEntries(rest),
      });
    }).pipe(logLevel),
  options,
);

test.provider(
  "a tenant that already exists is never disabled, and buckets keep working",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // The bucket's implicit enablement comes first, so the tenant predates
      // the resource and `disableOnDelete` must not apply to it.
      const bucket = yield* stack.deploy(Stackit.ObjectStorage.Bucket("TenantBucket", {}));
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const kept = yield* Stackit.ObjectStorage.Bucket("TenantBucket", {});
          const tenant = yield* Stackit.ObjectStorage.Project("Existing", {
            disableOnDelete: true,
          });
          return { kept, tenant };
        }),
      );
      expect(deployed.tenant.enabledByAlchemy).toEqual(false);
      expect(deployed.tenant.disableOnDelete).toEqual(true);
      expect(deployed.kept.bucketName).toEqual(bucket.bucketName);

      yield* stack.destroy();
      expect((yield* observeTenant(projectId, region))?.project).toEqual(projectId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(!owner)(
  "disableOnDelete disables a tenant this resource enabled",
  (stack) =>
    Effect.gen(function* () {
      const { region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const project = Stackit.ResourceManager.Project("TenantProject", { owner: owner! });
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const sandbox = yield* project;
          const tenant = yield* Stackit.ObjectStorage.Project("Fresh", {
            projectId: sandbox.projectId,
            disableOnDelete: true,
          });
          return { sandbox, tenant };
        }),
      );
      const projectId = deployed.sandbox.projectId;
      expect(deployed.tenant.enabledByAlchemy).toEqual(true);
      expect((yield* observeTenant(projectId, region))?.project).toEqual(projectId);

      // Removing the resource disables the service; the project stays deployed.
      yield* stack.deploy(project);
      const gone = yield* observeTenant(projectId, region).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (status) => status === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: stackitTags("objectstorage", "project"), timeout: 1_200_000 },
);
