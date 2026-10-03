import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  caller,
  labFixture,
  logLevel,
  subscription,
  tags,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getUser = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetUser({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

/**
 * Poll until the real profile is gone. For the calling principal the lab
 * answers GET with a synthesized profile (zero GUID, no provisioning
 * state) when no real profile exists, so that counts as gone too.
 */
const waitUserGone = (resourceGroupName: string, labName: string, name: string) =>
  getUser(resourceGroupName, labName, name).pipe(
    Effect.map((u) =>
      u.properties?.provisioningState === undefined
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  lab: "First" | "Second";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    // DevTest Labs only resolves the deploying principal as a lab user
    // (managed identities are "not found in the tenant"), so the
    // replacement moves the user to a second lab instead of changing the
    // principal. Both labs stay deployed across the replacement step.
    const { oid, tid } = yield* caller;
    const { group, lab: first } = yield* labFixture();
    const second = yield* Azure.DevTestLabs.Lab("Lab2", {
      resourceGroup: group.resourceGroupName,
      labStorageType: "Standard",
    });
    const lab = props.lab === "First" ? first : second;
    const user = yield* Azure.DevTestLabs.User("LabUser", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      objectId: oid,
      tenantId: tid,
      tags: props.tags,
    });
    return { group, lab, oid, user };
  });

// Two free labs (created in parallel); ~6 minutes.
test.provider(
  "create, update, replace, and delete a lab user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, oid, user } = yield* stack.deploy(
        program({ lab: "First", tags: { env: "test" } }),
      );
      expect(user.userName).toEqual(oid);
      const get = (labName: string, name: string) =>
        getUser(group.resourceGroupName, labName, name);
      const observed = yield* get(lab.labName, user.userName);
      expect(observed.properties?.identity?.objectId).toEqual(oid);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ lab: "First", tags: { env: "prod" } }),
      );
      expect(updated.user.userId).toEqual(user.userId);
      expect((yield* get(lab.labName, user.userName)).tags?.env).toEqual(
        "prod",
      );

      // Replacement: a different lab.
      const replaced = yield* stack.deploy(
        program({ lab: "Second", tags: { env: "prod" } }),
      );
      expect(replaced.user.lab).toEqual(replaced.lab.labName);
      expect(replaced.user.userId).not.toEqual(user.userId);
      const moved = yield* get(replaced.lab.labName, replaced.user.userName);
      expect(moved.properties?.provisioningState).toEqual("Succeeded");
      expect(moved.tags?.env).toEqual("prod");
      expect(
        yield* waitUserGone(group.resourceGroupName, lab.labName, user.userName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitUserGone(
          group.resourceGroupName,
          replaced.lab.labName,
          replaced.user.userName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
