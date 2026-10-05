import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/azure/batch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, regions, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Zip with one file, `hello.sh` (generated once, checked in). */
const HELLO_ZIP =
  "UEsDBBQAAAAAALWrQl151D8XFQAAABUAAAAIAAAAaGVsbG8uc2gjIS9iaW4vc2gKZWNobyBoZWxsbwpQSwECFAMUAAAAAAC1q0JdedQ/FxUAAAAVAAAACAAAAAAAAAAAAAAAgAEAAAAAaGVsbG8uc2hQSwUGAAAAAAEAAQA2AAAAOwAAAAAA";

const getPackage = (
  resourceGroupName: string,
  accountName: string,
  applicationName: string,
  versionName: string,
) =>
  Effect.gen(function* () {
    return yield* batch.GetApplicationPackage({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      applicationName,
      versionName,
    });
  });

const program = (props: { version: string; content?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: regions.applicationPackage,
    });
    const storage = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
      location: regions.applicationPackage,
    });
    const account = yield* Azure.Batch.Account("Jobs", {
      resourceGroup: group.resourceGroupName,
      location: regions.applicationPackage,
      autoStorage: { storageAccountId: storage.storageAccountId },
    });
    const app = yield* Azure.Batch.Application("Hello", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: "hello",
    });
    const pkg = yield* Azure.Batch.ApplicationPackage("HelloPackage", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      application: app.applicationName,
      version: props.version,
      content: props.content,
    });
    return { group, account, app, pkg };
  });

// Account, application, and a tiny blob in Standard_LRS storage: ~$0.
test.provider(
  "create, activate, replace, and delete a batch application package",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // A package without content stays Pending.
      const { group, account, pkg } = yield* stack.deploy(
        program({ version: "1.0.0" }),
      );
      expect(pkg.version).toEqual("1.0.0");
      expect(pkg.state).toEqual("Pending");
      const get = (version: string) =>
        getPackage(
          group.resourceGroupName,
          account.accountName,
          "hello",
          version,
        );
      expect((yield* get("1.0.0")).properties?.state).toEqual("Pending");

      // Adding content uploads and activates the package in place.
      const withContent = yield* stack.deploy(
        program({ version: "1.0.0", content: HELLO_ZIP }),
      );
      expect(withContent.pkg.state).toEqual("Active");
      expect(withContent.pkg.packageId).toEqual(pkg.packageId);
      expect(withContent.pkg.format).toEqual("zip");
      expect(withContent.pkg.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const active = yield* get("1.0.0");
      expect(active.properties?.state).toEqual("Active");
      expect(active.properties?.lastActivationTime).toBeDefined();

      // Replacement: new version.
      const replaced = yield* stack.deploy(
        program({ version: "2.0.0", content: HELLO_ZIP }),
      );
      expect(replaced.pkg.version).toEqual("2.0.0");
      expect((yield* get("2.0.0")).properties?.state).toEqual("Active");
      expect(yield* waitGone(get("1.0.0"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("2.0.0"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
