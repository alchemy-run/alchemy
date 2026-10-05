import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datadog from "@distilled.cloud/azure/datadog";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  acceptDatadogTerms,
  location,
  logLevel,
  runWithDatadogUser,
  subscription,
  tags,
  userInfo,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMonitor = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* datadog.GetMonitor({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
    });
  });

const program = (props: {
  monitoringStatus: "Enabled" | "Disabled";
  tags: Record<string, string>;
  userEmail?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const monitor = yield* Azure.Datadog.Monitor("Monitor", {
      resourceGroup: group.resourceGroupName,
      location,
      userInfo: {
        ...userInfo,
        emailAddress: props.userEmail ?? userInfo.emailAddress,
      },
      monitoringStatus: props.monitoringStatus,
      tags: props.tags,
    });
    return { group, monitor };
  });

// Subscribes to the Datadog pay-as-you-go Marketplace plan ($0 list price;
// Datadog bills per host / log GB, ~$0 for a minutes-old org, but it creates
// a real Datadog organization). Provisioning ~3-10 minutes. Free trial and
// sponsored subscriptions cannot purchase Marketplace SaaS plans; run only
// with AZURE_TEST_PAID=1 and AZURE_TEST_DATADOG_USER_TOKEN=1 (user sign-in).
// The test accepts the Datadog Marketplace terms.
test.provider.skipIf(!runWithDatadogUser)(
  "create, update, replace, and delete a datadog monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* acceptDatadogTerms;

      const { group, monitor } = yield* stack.deploy(
        program({ monitoringStatus: "Enabled", tags: { env: "test" } }),
      );
      expect(monitor.monitorId).not.toEqual("");
      const observed = yield* getMonitor(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.monitoringStatus).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");

      // In place: monitoring status and tags.
      const updated = yield* stack.deploy(
        program({ monitoringStatus: "Disabled", tags: { env: "prod" } }),
      );
      expect(updated.monitor.monitorId).toEqual(monitor.monitorId);
      const patched = yield* getMonitor(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(patched.properties?.monitoringStatus).toEqual("Disabled");
      expect(patched.tags?.env).toEqual("prod");

      // Replacement: the organization owner is create-only.
      const replaced = yield* stack.deploy(
        program({
          monitoringStatus: "Disabled",
          tags: { env: "prod" },
          userEmail: "alchemy-test+replaced@example.com",
        }),
      );
      expect(replaced.monitor.monitorName).not.toEqual(monitor.monitorName);
      expect(
        yield* waitGone(
          getMonitor(group.resourceGroupName, monitor.monitorName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getMonitor(group.resourceGroupName, replaced.monitor.monitorName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Probe ($0, nothing is created): with the Marketplace terms accepted and a
// valid pay-as-you-go plan, Datadog still rejects creating a new
// organization for the service-principal test identity.
test.provider.skipIf(runWithDatadogUser)(
  "datadog rejects a new organization for a service principal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* acceptDatadogTerms;
      const error = yield* stack
        .deploy(program({ monitoringStatus: "Enabled", tags: {} }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("DatadogMonitorCreationFailed");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
