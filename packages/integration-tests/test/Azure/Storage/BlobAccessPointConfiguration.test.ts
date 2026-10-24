import * as Azure from "@alchemy.run/azure";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfiguration = (rg: string, account: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetBlobAccessPointConfiguration({
      subscriptionId,
      resourceGroupName: rg,
      accountName: account,
      blobAccessPointConfigurationName: name,
    });
  });

const configurationGone = (rg: string, account: string, name: string) =>
  getConfiguration(rg, account, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const base = (allowBlobAccessPoints: boolean) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
      dataCollaborationPolicy: { allowBlobAccessPoints },
    });
    return { group, account };
  });

// Standard_LRS account: ~$0, ~1 minute. Creates nothing beyond the account:
// Azure rejects the configuration before accepting it.
test.provider(
  "probe: blob access points need allowBlobAccessPoints on the account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, account } = yield* stack.deploy(base(false));
      expect(account.dataCollaborationPolicy.allowBlobAccessPoints ?? false).toEqual(false);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* storage
        .CreateBlobAccessPointConfiguration({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.storageAccountName,
          blobAccessPointConfigurationName: "alchemy-probe",
          location: "eastus",
          properties: {
            source: {
              sourceType: "S3Compatible",
              connection: { connectionType: "Endpoint", endpoint: "https://s3.example.com" },
              auth: {
                authType: "AccessKey",
                accessKeyId: "alchemy-probe",
                secretAccessKey: Redacted.make("alchemy-probe-secret"),
              },
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("StorageDataCollaborationNotAllowed");

      // The account flag is an in-place update.
      const enabled = yield* stack.deploy(base(true));
      expect(enabled.account.storageAccountName).toEqual(account.storageAccountName);
      expect(enabled.account.dataCollaborationPolicy.allowBlobAccessPoints).toEqual(true);
      const observed = yield* storage.GetStorageAccountProperties({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        accountName: account.storageAccountName,
      });
      expect(observed.properties?.dataCollaborationPolicyProperties?.allowBlobAccessPoints).toEqual(
        true,
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);

const endpoint = process.env.AZURE_TEST_S3_ENDPOINT ?? "https://s3.example.com";
const secondEndpoint = process.env.AZURE_TEST_S3_ENDPOINT_2 ?? "https://s3-alt.example.com";
const accessKeyId = process.env.AZURE_TEST_S3_ACCESS_KEY_ID ?? "alchemy-test";
const secret = (value: string | undefined) => Redacted.make(value ?? "alchemy-test-secret");

const program = (config?: {
  description: string;
  state?: "Active" | "Inactive";
  secretAccessKey: Redacted.Redacted<string>;
  endpoint?: string;
}) =>
  Effect.gen(function* () {
    const resources = yield* base(true);
    const accessPoint = config
      ? yield* Azure.Storage.BlobAccessPointConfiguration("Archive", {
          resourceGroup: resources.group.resourceGroupName,
          storageAccount: resources.account.storageAccountName,
          sourceType: "S3Compatible",
          endpoint: config.endpoint ?? endpoint,
          accessKeyId,
          secretAccessKey: config.secretAccessKey,
          description: config.description,
          state: config.state,
        })
      : undefined;
    return { ...resources, accessPoint };
  });

// Needs a reachable S3-compatible data store (an external system): set
// AZURE_TEST_S3_ENDPOINT, AZURE_TEST_S3_ENDPOINT_2 (replacement step),
// AZURE_TEST_S3_ACCESS_KEY_ID, AZURE_TEST_S3_SECRET_ACCESS_KEY, and
// AZURE_TEST_S3_SECRET_ACCESS_KEY_2 (rotation step). Against an unreachable
// endpoint Azure accepts the PUT, then leaves the configuration in
// `Accepted` and a later delete in `Deleting` for more than 10 minutes.
// The configuration itself is free.
// ~$0/run, 5 min
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a blob access point configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          description: "first",
          secretAccessKey: secret(process.env.AZURE_TEST_S3_SECRET_ACCESS_KEY),
        }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const name = created.accessPoint!.configurationName;
      expect(created.accessPoint!.state).toEqual("Active");
      expect(created.accessPoint!.uniqueId).toMatch(/^[0-9a-f-]{36}$/i);
      const observed = yield* getConfiguration(rg, acct, name);
      expect(observed.properties.description).toEqual("first");
      expect(observed.properties.source.sourceType).toEqual("S3Compatible");
      expect(observed.properties.source.connection?.endpoint).toEqual(endpoint);
      expect(observed.properties.source.auth?.accessKeyId).toEqual(accessKeyId);

      // In-place update: description, state, and a rotated secret key.
      const updated = yield* stack.deploy(
        program({
          description: "second",
          state: "Inactive",
          secretAccessKey: secret(
            process.env.AZURE_TEST_S3_SECRET_ACCESS_KEY_2 ??
              process.env.AZURE_TEST_S3_SECRET_ACCESS_KEY,
          ),
        }),
      );
      expect(updated.accessPoint!.uniqueId).toEqual(created.accessPoint!.uniqueId);
      const reobserved = yield* getConfiguration(rg, acct, name);
      expect(reobserved.properties.description).toEqual("second");
      expect(reobserved.properties.state).toEqual("Inactive");

      // Replacement: a new endpoint creates a new configuration.
      const replaced = yield* stack.deploy(
        program({
          description: "second",
          state: "Inactive",
          secretAccessKey: secret(process.env.AZURE_TEST_S3_SECRET_ACCESS_KEY),
          endpoint: secondEndpoint,
        }),
      );
      const replacedName = replaced.accessPoint!.configurationName;
      expect(replacedName).not.toEqual(name);
      expect(replaced.accessPoint!.endpoint).toEqual(secondEndpoint);
      expect(yield* configurationGone(rg, acct, name)).toEqual("gone");

      yield* stack.deploy(program());
      expect(yield* configurationGone(rg, acct, replacedName)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 1_800_000,
  },
);
