import * as Azure from "@alchemy.run/azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as servicePrincipals from "@distilled.cloud/microsoft-graph/servicePrincipals";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const subscriptionId = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** First-party "Azure Cosmos DB" application. */
const COSMOS_DB_APP_ID = "a232010e-820c-4083-83bb-3ace5fc29d0b";

/** Object ID of the Azure Cosmos DB service principal in this tenant. */
export const cosmosPrincipalId = Effect.gen(function* () {
  const principal = yield* servicePrincipals.getServicePrincipalByAppId({
    appId: COSMOS_DB_APP_ID,
    select: ["id"],
  });
  expect(principal.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return principal.id!;
});

/**
 * Poll an out-of-band GET until it reports not-found. Only typed not-found
 * tags count as gone.
 */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>, times = 40) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times,
    }),
  );

/**
 * Region for Cosmos DB tests. Free-trial serverless accounts in `eastus`
 * sat in `Creating` for 25+ minutes; `centralus` provisions in ~1 minute.
 */
export const COSMOS_LOCATION = "centralus";
