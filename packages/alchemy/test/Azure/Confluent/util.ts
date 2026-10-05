import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:confluent", "live"];

/**
 * Microsoft.Confluent rejects environment/cluster/topic/connector writes made
 * with a service-principal token (`ConfluentUserTokenRequired`: "Both UPN and
 * Email claims are missing in the ARM signed token"). Their lifecycles run
 * only with `AZURE_TEST_CONFLUENT_USER_TOKEN=1` on a profile that signs in as
 * a user; otherwise the Environment probe asserts the rejection.
 */
export const runWithConfluentUser =
  runPaidOnly && !!process.env.AZURE_TEST_CONFLUENT_USER_TOKEN;

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

const baseEmail =
  process.env.AZURE_TEST_CONFLUENT_EMAIL ?? "alchemy-test@example.com";

/**
 * Per-run mailbox tag. Confluent Cloud keeps a signed-up email after its
 * organization is deleted (a re-signup 25 minutes later still fails with
 * `ConfluentEmailAlreadyExists`), so every run signs up with a fresh
 * plus-addressed mailbox. It is payload data, not a resource name.
 */
const runTag = Math.random().toString(36).slice(2, 8);

/** First user of a test organization, unique per test file and run. */
export const userDetailFor = (scope = "org") => {
  const [local, domain] = baseEmail.split("@");
  return {
    emailAddress: `${local}+${scope}-${runTag}@${domain}`,
    firstName: "Alchemy",
    lastName: "Test",
  };
};

export const userDetail = userDetailFor();

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
export const organizationStack = (scope: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const organization = yield* Azure.Confluent.Organization("Org", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      userDetail: userDetailFor(scope),
    });
    const environment = yield* Azure.Confluent.Environment("Env", {
      resourceGroup: group.resourceGroupName,
      organization: organization.organizationName,
    });
    return { group, organization, environment };
  });

/** Organization stack plus a Basic single-zone cluster. */
export const clusterStack = (scope: string) =>
  Effect.gen(function* () {
    const parents = yield* organizationStack(scope);
    const cluster = yield* Azure.Confluent.Cluster("Cluster", {
      resourceGroup: parents.group.resourceGroupName,
      organization: parents.organization.organizationName,
      environment: parents.environment.environmentId,
      kind: "Basic",
      region: "eastus",
    });
    return { ...parents, cluster };
  });
