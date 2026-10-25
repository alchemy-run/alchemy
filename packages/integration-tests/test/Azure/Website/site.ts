import * as Azure from "@alchemy.run/azure";
import { orUndefinedIfNotFound } from "@alchemy.run/azure/Arm";
import * as cdn from "@distilled.cloud/azure/cdn";
import * as resources from "@distilled.cloud/azure/resources";
import * as storage from "@distilled.cloud/azure/storage";
import * as blob from "@distilled.cloud/azure/storage-blob";
import { expect } from "alchemy-test";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:website", "live"];

/** Offers Flex Consumption (server builds) and Blob static websites. */
export const LOCATION = "eastus";

/**
 * A Front Door site test: ~2 min deploy, 10-20 min until a new endpoint
 * serves everywhere, then a profile delete of 5-30 min (measured: 19 min of
 * propagation and more than 16 min of profile delete in one run). Run these
 * files with `timeout 3600`. One test file shares one profile.
 */
export const FRONT_DOOR_TIMEOUT = 3_300_000;

/** Clones live under the workspace so fixtures resolve hoisted packages. */
export const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

export const cloudflareFixture = (name: string) =>
  pathe.resolve(import.meta.dirname, "../../Cloudflare/Website", name);

export const fixture = (name: string) => pathe.resolve(import.meta.dirname, "fixtures", name);

/** `https://{account}.z<N>.web.core.windows.net` */
export const storageWebUrl = /^https:\/\/[a-z0-9]+\.z\d+\.web\.core\.windows\.net$/;

/** `https://{endpoint}-{hash}.{zone}.azurefd.net` */
export const frontDoorUrl = /^https:\/\/[a-z0-9-]+\.[a-z0-9]+\.azurefd\.net$/;

const subscription = Effect.map(Azure.AzureEnvironment.current, (env) => env.subscriptionId);

export interface Page {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/** One GET of the deployed site (the user's own endpoint) with status, body, and headers. */
export const fetchPage = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    const body = yield* response.text;
    return {
      status: response.status,
      body,
      headers: response.headers as Readonly<Record<string, string | undefined>>,
    } satisfies Page;
  }).pipe(Effect.timeout("15 seconds"), Effect.provide(FetchHttpClient.layer));

/**
 * Poll `url` until `check` holds. The default (3 s × 40) suits a storage
 * endpoint; pass {@link frontDoorWait} for a new Front Door endpoint.
 */
export const waitForPage = (
  url: string,
  check: (page: Page) => boolean,
  options: { spacing?: Duration.Input; times?: number } = {},
) =>
  fetchPage(url).pipe(
    Effect.flatMap((page) =>
      check(page)
        ? Effect.succeed(page)
        : Effect.fail(new Error(`${url} not ready: ${page.status}`)),
    ),
    Effect.retry({
      schedule: Schedule.spaced(options.spacing ?? "3 seconds"),
      times: options.times ?? 40,
    }),
  );

/** Route propagation of a new Front Door endpoint: 30 s × 50 (25 minutes). */
export const frontDoorWait = { spacing: "30 seconds", times: 50 } as const;

/** Whether a response came through Front Door (it stamps every response with `x-azure-ref`). */
export const viaFrontDoor = (page: Page) => (page.headers["x-azure-ref"] ?? "").length > 0;

/** Out-of-band: the static website endpoint is enabled on the account. */
export const staticWebsiteEnabled = (accountName: string) =>
  blob
    .GetServiceProperties({ url: `https://${accountName}.blob.core.windows.net` })
    .pipe(Effect.map((properties) => properties.StaticWebsite?.Enabled === true));

/** Out-of-band: a blob in the account's `$web` container (`undefined` when missing). */
export const webBlob = (accountName: string, name: string) =>
  blob
    .GetBlobProperties({
      url: `https://${accountName}.blob.core.windows.net`,
      containerName: "$web",
      blob: name,
    })
    .pipe(Effect.catchTag("BlobNotFound", () => Effect.succeed(undefined)));

/** Out-of-band: the storage account (`undefined` once gone). */
export const getStorageAccount = (resourceGroup: string, accountName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    return yield* orUndefinedIfNotFound(
      storage.GetStorageAccountProperties({
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName,
      }),
    );
  });

/** Out-of-band: the Front Door endpoint (`undefined` once gone). */
export const getEndpoint = (resourceGroup: string, profileName: string, endpointName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    return yield* orUndefinedIfNotFound(
      cdn.GetAFDEndpoint({
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName,
        endpointName,
      }),
    );
  });

/** Out-of-band: the Front Door profile (`undefined` once gone). */
export const getProfile = (resourceGroup: string, profileName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    return yield* orUndefinedIfNotFound(
      cdn.GetProfile({ subscriptionId, resourceGroupName: resourceGroup, profileName }),
    );
  });

/** Assert the site's resource group is gone (polls while ARM finishes the delete). */
export const assertGroupGone = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const group = yield* orUndefinedIfNotFound(
      resources.GetResourceGroup({ subscriptionId, resourceGroupName }),
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (group) => group === undefined,
        times: 60,
      }),
    );
    expect(group).toBeUndefined();
  });
