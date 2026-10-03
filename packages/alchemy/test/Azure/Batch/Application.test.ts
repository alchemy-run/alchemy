import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/azure/batch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, regions, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApplication = (
  resourceGroupName: string,
  accountName: string,
  applicationName: string,
) =>
  Effect.gen(function* () {
    return yield* batch.GetApplication({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      applicationName,
    });
  });

const program = (props: {
  name: string;
  displayName: string;
  allowUpdates: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: regions.application,
    });
    // Applications need an account with auto-storage.
    const storage = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
      location: regions.application,
    });
    const account = yield* Azure.Batch.Account("Jobs", {
      resourceGroup: group.resourceGroupName,
      location: regions.application,
      autoStorage: { storageAccountId: storage.storageAccountId },
    });
    const app = yield* Azure.Batch.Application("Renderer", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      displayName: props.displayName,
      allowUpdates: props.allowUpdates,
    });
    return { group, account, app };
  });

// Batch accounts and applications are free; empty Standard_LRS storage ~$0.
test.provider(
  "create, update, replace, and delete a batch application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, app } = yield* stack.deploy(
        program({
          name: "renderer",
          displayName: "Renderer",
          allowUpdates: true,
        }),
      );
      expect(app.applicationName).toEqual("renderer");
      expect(app.displayName).toEqual("Renderer");
      const get = (name: string) =>
        getApplication(group.resourceGroupName, account.accountName, name);
      const observed = yield* get("renderer");
      expect(observed.properties?.allowUpdates).toEqual(true);

      // In-place: display name and allowUpdates.
      const updated = yield* stack.deploy(
        program({
          name: "renderer",
          displayName: "Frame renderer",
          allowUpdates: false,
        }),
      );
      expect(updated.app.applicationId).toEqual(app.applicationId);
      const after = yield* get("renderer");
      expect(after.properties?.displayName).toEqual("Frame renderer");
      expect(after.properties?.allowUpdates).toEqual(false);

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({
          name: "encoder",
          displayName: "Frame renderer",
          allowUpdates: false,
        }),
      );
      expect(replaced.app.applicationName).toEqual("encoder");
      expect((yield* get("encoder")).name).toEqual("encoder");
      expect(yield* waitGone(get("renderer"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("encoder"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
