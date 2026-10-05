import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as datadog from "@distilled.cloud/azure/datadog";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:datadog", "live"];

/**
 * Creating a new Datadog organization is a Marketplace SaaS purchase that
 * Datadog rejects for service-principal callers (`DatadogMonitorCreationFailed`
 * "ResourceCreationFailed: Bad Request"). Monitor lifecycles run only with
 * `AZURE_TEST_DATADOG_USER_TOKEN=1` on a profile that signs in as a user;
 * otherwise the Monitor probe asserts the rejection.
 */
export const runWithDatadogUser =
  runPaidOnly && !!process.env.AZURE_TEST_DATADOG_USER_TOKEN;

/** Datadog monitors are only offered in a few regions. */
export const location = "westus2";

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Owner of the test Datadog organization (any reachable mailbox works). */
export const userInfo = {
  name: "Alchemy Test",
  emailAddress:
    process.env.AZURE_TEST_DATADOG_EMAIL ?? "alchemy-test@example.com",
};

/**
 * Accept the Microsoft Marketplace + Datadog terms for the subscription
 * (idempotent). Without it every monitor PUT fails with
 * `ResourceCreationValidateFailed`.
 */
export const acceptDatadogTerms = Effect.gen(function* () {
  yield* datadog.MarketplaceAgreementsCreateOrUpdate({
    subscriptionId: yield* subscription,
    properties: { accepted: true },
  });
});

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

/** Group + monitor, the parents of every child test. */
export const monitorStack = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const monitor = yield* Azure.Datadog.Monitor("Monitor", {
    resourceGroup: group.resourceGroupName,
    location,
    userInfo,
  });
  return { group, monitor };
});
