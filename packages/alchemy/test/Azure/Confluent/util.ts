import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:confluent", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** First user of the test organization (any reachable mailbox works). */
export const userDetail = {
  emailAddress:
    process.env.AZURE_TEST_CONFLUENT_EMAIL ?? "alchemy-test@example.com",
  firstName: "Alchemy",
  lastName: "Test",
};

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

/** Group + organization + environment, the parents of every child test. */
export const organizationStack = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const organization = yield* Azure.Confluent.Organization("Org", {
    resourceGroup: group.resourceGroupName,
    location: "eastus",
    userDetail,
  });
  const environment = yield* Azure.Confluent.Environment("Env", {
    resourceGroup: group.resourceGroupName,
    organization: organization.organizationName,
  });
  return { group, organization, environment };
});

/** Organization stack plus a Basic single-zone cluster. */
export const clusterStack = Effect.gen(function* () {
  const parents = yield* organizationStack;
  const cluster = yield* Azure.Confluent.Cluster("Cluster", {
    resourceGroup: parents.group.resourceGroupName,
    organization: parents.organization.organizationName,
    environment: parents.environment.environmentId,
    kind: "Basic",
    region: "eastus",
  });
  return { ...parents, cluster };
});
