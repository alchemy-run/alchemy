import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as storage from "@distilled.cloud/azure/storage";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// One Standard_LRS storage account with an empty container: a fraction of a
// cent per run, about 1 minute.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });

const subscriptionId = Azure.AzureEnvironment.current.pipe(
  Effect.map((env) => env.subscriptionId),
  Effect.provide(azure),
);

const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const id = yield* subscriptionId;
    return yield* storage
      .GetStorageAccountProperties({ subscriptionId: id, resourceGroupName, accountName })
      .pipe(Effect.provide(azure));
  });

const getContainer = (resourceGroupName: string, accountName: string, containerName: string) =>
  Effect.gen(function* () {
    const id = yield* subscriptionId;
    return yield* storage
      .GetBlobContainer({ subscriptionId: id, resourceGroupName, accountName, containerName })
      .pipe(Effect.provide(azure));
  });

/** Poll until the deleted account reads as gone. */
const accountGone = (resourceGroupName: string, accountName: string) =>
  getAccount(resourceGroupName, accountName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const out = yield* stack;
    yield* destroy(Stack);
    const status = yield* accountGone(out.resourceGroup, out.storageAccount);
    expect(status).toBe("gone");
  }),
  { timeout: 600_000 },
);

test(
  "deploys an HTTPS-only Standard_LRS storage account",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.resourceGroup).toStartWith("AzureStorageExample-");
    expect(out.blobEndpoint).toBe(`https://${out.storageAccount}.blob.core.windows.net/`);

    const account = yield* getAccount(out.resourceGroup, out.storageAccount);
    expect({
      provisioningState: account.properties?.provisioningState,
      sku: account.sku?.name,
      kind: account.kind,
      supportsHttpsTrafficOnly: account.properties?.supportsHttpsTrafficOnly,
      minimumTlsVersion: account.properties?.minimumTlsVersion,
      allowBlobPublicAccess: account.properties?.allowBlobPublicAccess,
    }).toEqual({
      provisioningState: "Succeeded",
      sku: "Standard_LRS",
      kind: "StorageV2",
      supportsHttpsTrafficOnly: true,
      minimumTlsVersion: "TLS1_2",
      allowBlobPublicAccess: false,
    });
  }),
  { timeout: 120_000 },
);

test(
  "deploys a private blob container in the account",
  Effect.gen(function* () {
    const out = yield* stack;
    const container = yield* getContainer(out.resourceGroup, out.storageAccount, out.container);
    expect(container.name).toBe(out.container);
    expect(container.properties?.publicAccess).toBe("None");
  }),
  { timeout: 120_000 },
);
