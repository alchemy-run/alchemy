import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLab = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetLab({
      subscriptionId: yield* subscription,
      resourceGroupName,
      name,
    });
  });

const program = (props: {
  announcement: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const lab = yield* Azure.DevTestLabs.Lab("Lab", {
      resourceGroup: group.resourceGroupName,
      labStorageType: "Standard",
      announcement: {
        title: props.announcement,
        markdown: `${props.announcement} body`,
        enabled: "Enabled",
      },
      tags: props.tags,
    });
    return { group, lab };
  });

// The lab is free; its storage accounts and Key Vault cost ~$0. Creation
// takes 2-5 minutes, delete a few more.
test.provider(
  "create, update, and delete a lab",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab } = yield* stack.deploy(
        program({ announcement: "Welcome", tags: { env: "test" } }),
      );
      expect(lab.labName.length).toBeGreaterThan(0);
      expect(lab.vaultName).toBeDefined();
      expect(lab.defaultStorageAccount).toBeDefined();
      const observed = yield* getLab(group.resourceGroupName, lab.labName);
      expect(observed.properties.labStorageType).toEqual("Standard");
      expect(observed.properties.announcement?.title).toEqual("Welcome");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Lab");

      // In-place: announcement + tags.
      const updated = yield* stack.deploy(
        program({ announcement: "Maintenance", tags: { env: "prod" } }),
      );
      expect(updated.lab.labId).toEqual(lab.labId);
      const reobserved = yield* getLab(group.resourceGroupName, lab.labName);
      expect(reobserved.properties.announcement?.title).toEqual("Maintenance");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(getLab(group.resourceGroupName, lab.labName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
