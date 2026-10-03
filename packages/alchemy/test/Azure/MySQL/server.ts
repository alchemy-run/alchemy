import * as Azure from "@/Azure";
import * as mysql from "@distilled.cloud/azure/mysql";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

/**
 * The free trial is restricted from provisioning flexible servers in
 * several regions (`ProvisionNotSupportedForRegion` in centralus, westus3);
 * westus2 accepts them.
 */
export const MYSQL_TEST_LOCATION = "westus2";

export const tags = ["provider:azure", "provider:azure:mysql", "live"];

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Resource group + the cheapest flexible server (Burstable B1ms, 20 GiB:
 * ≈ $0.02/h, 4-8 min to create) that child-resource tests attach to.
 */
export const testServer = (
  props: Partial<Azure.MySQL.FlexibleServerProps> = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const server = yield* Azure.MySQL.FlexibleServer("Server", {
      ...props,
      resourceGroup: group.resourceGroupName,
      location: MYSQL_TEST_LOCATION,
    });
    return { group, server };
  });

export const serverRef = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, serverName };
  });

/** Poll `get` until it fails with a typed not-found tag (bounded). */
export const untilGone = <A, R>(
  get: Effect.Effect<A, mysql.GetServerError, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "FirewallRuleNotExist"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );
