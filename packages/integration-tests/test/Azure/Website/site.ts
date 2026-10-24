import * as Azure from "@alchemy.run/azure";
import { orUndefinedIfNotFound } from "@alchemy.run/azure/Arm";
import * as resources from "@distilled.cloud/azure/resources";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:website", "live"];

export const LOCATION = "eastus";

/** App Service plans are created in westus3 (see the Web suites). */
export const APP_SERVICE_LOCATION = "westus3";

/** Clones live under the workspace so fixtures resolve hoisted packages. */
export const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

export const cloudflareFixture = (name: string) =>
  pathe.resolve(import.meta.dirname, "../../Cloudflare/Website", name);

/** `https://{account}.z<N>.web.core.windows.net` */
export const storageWebUrl = /^https:\/\/[a-z0-9]+\.z\d+\.web\.core\.windows\.net$/;

/** `https://{site}.azurewebsites.net` (optionally with a regional suffix). */
export const appServiceUrl = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.azurewebsites\.net$/;

const subscription = Effect.map(Azure.AzureEnvironment.current, (env) => env.subscriptionId);

/** One GET with the status, body, and content type. */
export const fetchPage = (url: string, init?: RequestInit) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return {
      status: response.status,
      body: await response.text(),
      type: response.headers.get("content-type"),
    };
  });

/** Poll `url` until `check` holds, or fail after ~2 minutes by default. */
export const waitForPage = (
  url: string,
  check: (page: { status: number; body: string }) => boolean,
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

/** Out-of-band: the static website endpoint is enabled on the account. */
export const staticWebsiteEnabled = (resourceGroup: string, accountName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const account = yield* storage.GetStorageAccountProperties({
      subscriptionId,
      resourceGroupName: resourceGroup,
      accountName,
    });
    return account.properties?.primaryEndpoints?.web !== undefined;
  });

/** Out-of-band: the web app's Node.js stack and startup command. */
export const webAppConfig = (resourceGroup: string, name: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const config = yield* web.GetWebAppConfiguration({
      subscriptionId,
      resourceGroupName: resourceGroup,
      name,
    });
    return {
      linuxFxVersion: config.properties?.linuxFxVersion,
      appCommandLine: config.properties?.appCommandLine,
    };
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
