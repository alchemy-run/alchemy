import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// A deleted custom role keeps its id for 37 days; reruns undelete it.
const ROLE_ID = "alchemyTestObjectReader";

test.provider(
  "create, update, and delete a custom role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        GCP.IAM.Role("Reader", {
          roleId: ROLE_ID,
          title: "Alchemy test object reader",
          description: "test role",
          permissions: ["storage.objects.get"],
        }),
      );
      expect(created.roleId).toEqual(ROLE_ID);
      expect(created.name).toEqual(`projects/${created.project}/roles/${ROLE_ID}`);
      expect(created.permissions).toEqual(["storage.objects.get"]);
      expect(created.description).toEqual("test role");
      expect(created.stage).toEqual("GA");

      const updated = yield* stack.deploy(
        GCP.IAM.Role("Reader", {
          roleId: ROLE_ID,
          title: "Alchemy test object reader",
          description: "test role",
          permissions: ["storage.objects.list", "storage.objects.get"],
          stage: "BETA",
        }),
      );
      expect(updated.permissions).toEqual(["storage.objects.get", "storage.objects.list"]);
      expect(updated.stage).toEqual("BETA");

      const fetched = yield* iam.getProjectsRoles({ name: created.name });
      expect([...(fetched.includedPermissions ?? [])].sort()).toEqual([
        "storage.objects.get",
        "storage.objects.list",
      ]);

      yield* stack.destroy();

      const deleted = yield* iam.getProjectsRoles({ name: created.name });
      expect(deleted.deleted).toEqual(true);
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iam", "live"], timeout: 180_000 },
);
