import * as Azure from "@/Azure";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

/**
 * The free trial is restricted from provisioning flexible servers in
 * eastus (and eastus2, westus2, southcentralus, westeurope); centralus
 * accepts them.
 */
export const POSTGRES_TEST_LOCATION = "centralus";

export const tags = ["provider:azure", "provider:azure:postgresql", "live"];

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Resource group + the cheapest flexible server (Burstable B1ms, 32 GiB:
 * ≈ $0.02/h, 4-8 min to create) that child-resource tests attach to.
 */
export const testServer = (
  props: Partial<Azure.PostgreSQL.FlexibleServerProps> = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const server = yield* Azure.PostgreSQL.FlexibleServer("Server", {
      ...props,
      resourceGroup: group.resourceGroupName,
      location: POSTGRES_TEST_LOCATION,
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
  get: Effect.Effect<A, postgresql.GetServerError, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    // Missing administrators come back as a bare 404 (`NotFound`).
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );
