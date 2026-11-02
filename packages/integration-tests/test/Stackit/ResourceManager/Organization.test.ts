import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Labels on the organization are visible across the whole account, and the
// rename is too, so the mutating cases need an explicit opt-in.
const mutate = !!process.env.STACKIT_TEST_ORGANIZATION_SETTINGS;

const options = {
  tags: stackitTags("resourcemanager", "organization"),
  timeout: 180_000,
  // One set of labels and one name per organization.
  exclusive: "stackit:organization",
} as const;

const getOrganization = (id: string) => resourceManager.getOrganization({ id });

test.provider(
  "an organization is only taken over with adopt",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      yield* stack.destroy();

      const organization = Stackit.ResourceManager.Organization("Org", {});
      const error = yield* stack.plan(organization).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const fetched = yield* getOrganization(env.organizationId!);
      expect(fetched.labels?.["alchemy.id"]).toBeUndefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a missing organization fails instead of being created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Stackit.ResourceManager.Organization("Org", {
            organizationId: "00000000-0000-0000-0000-000000000000",
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Stackit.ResourceManager.OrganizationNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(!mutate)(
  "adopt, label, rename and release an organization",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      const id = env.organizationId!;
      yield* stack.destroy();

      const before = yield* getOrganization(id);
      const organization = (props: { labels: Record<string, string>; name?: string }) =>
        Stackit.ResourceManager.Organization("Org", props).pipe(adopt(true));

      const adopted = yield* stack.deploy(
        organization({ labels: { alchemyTestEnv: "one", alchemyTestKeep: "yes" } }),
      );
      expect(adopted.containerId).toEqual(before.containerId);
      expect(adopted.name).toEqual(before.name);
      expect(adopted.labels).toMatchObject({ alchemyTestEnv: "one", alchemyTestKeep: "yes" });

      const labelled = yield* getOrganization(id);
      expect(labelled.labels?.["alchemy.id"]).toEqual("Org");
      expect(labelled.labels?.alchemyTestEnv).toEqual("one");

      const plan = yield* stack.plan(
        organization({ labels: { alchemyTestEnv: "one", alchemyTestKeep: "yes" } }),
      );
      expect(plan.resources.Org).toMatchObject({ action: "noop" });

      // A rename and a dropped label, in place. Foreign labels stay.
      const name = `${before.name.slice(0, 34)}-tested`;
      const renamed = yield* stack.deploy(
        organization({ labels: { alchemyTestEnv: "two" }, name }),
      );
      expect(renamed.name).toEqual(name);
      const updated = yield* getOrganization(id);
      expect(updated.name).toEqual(name);
      expect(updated.labels?.alchemyTestEnv).toEqual("two");
      expect(updated.labels?.alchemyTestKeep).toBeUndefined();
      for (const [key, value] of Object.entries(before.labels ?? {})) {
        expect(updated.labels?.[key]).toEqual(value);
      }

      // Destroy removes the labels it set and leaves the organization alone.
      yield* stack.destroy();
      const released = yield* getOrganization(id);
      expect(released.organizationId).toEqual(before.organizationId);
      expect(released.labels?.["alchemy.id"]).toBeUndefined();
      expect(released.labels?.alchemyTestEnv).toBeUndefined();
      for (const [key, value] of Object.entries(before.labels ?? {})) {
        expect(released.labels?.[key]).toEqual(value);
      }

      // Destroy keeps the current name, so restore the original out-of-band.
      yield* resourceManager.partialUpdateOrganization({ id, name: before.name });
    }).pipe(logLevel),
  options,
);
