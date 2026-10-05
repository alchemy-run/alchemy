import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as peering from "@distilled.cloud/azure/peering";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, serviceProvider, subscription, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * Connection Monitor tests only persist on a peering service whose
 * Connection Monitor is initialized with a Log Analytics agent running at
 * the customer site. Set `AZURE_TEST_PEERING_AGENT` (with
 * `AZURE_TEST_PAID=1`) to the agent name.
 */
const agent = process.env.AZURE_TEST_PEERING_AGENT ?? "";

const program = (frequency: number) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.Peering.PeeringService("Service", {
      resourceGroup: group.resourceGroupName,
      ...serviceProvider,
    });
    const monitor = yield* Azure.Peering.ConnectionMonitorTest("Monitor", {
      resourceGroup: group.resourceGroupName,
      peeringService: service.peeringServiceName,
      sourceAgent: agent,
      destination: "www.bing.com",
      destinationPort: 443,
      testFrequencyInSec: frequency,
    });
    return { group, service, monitor };
  });

const getTest = (
  resourceGroupName: string,
  peeringServiceName: string,
  connectionMonitorTestName: string,
) =>
  Effect.gen(function* () {
    return yield* peering.GetConnectionMonitorTest({
      subscriptionId: yield* subscription,
      resourceGroupName,
      peeringServiceName,
      connectionMonitorTestName,
    });
  });

// Free, but needs a Log Analytics agent at the customer site connected to
// the peering service's Connection Monitor workspace.
test.provider.skipIf(!runPaidOnly || !agent)(
  "create, update, and delete a connection monitor test",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program(30));
      const observed = yield* getTest(
        first.group.resourceGroupName,
        first.service.peeringServiceName,
        first.monitor.connectionMonitorTestName,
      );
      expect(observed.properties?.testFrequencyInSec).toEqual(30);

      const second = yield* stack.deploy(program(60));
      expect(second.monitor.connectionMonitorTestId).toEqual(
        first.monitor.connectionMonitorTestId,
      );
      const updated = yield* getTest(
        second.group.resourceGroupName,
        second.service.peeringServiceName,
        second.monitor.connectionMonitorTestName,
      );
      expect(updated.properties?.testFrequencyInSec).toEqual(60);

      yield* stack.destroy();
      // A missing test reads back as an empty body.
      const gone = yield* getTest(
        second.group.resourceGroupName,
        second.service.peeringServiceName,
        second.monitor.connectionMonitorTestName,
      ).pipe(
        Effect.map((test) => test.id),
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed(undefined),
        ),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: without Connection Monitor, Azure accepts the PUT but
// stores nothing, which is why the lifecycle needs an initialized agent.
test.provider(
  "a peering service without Connection Monitor stores no tests",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const service = yield* Azure.Peering.PeeringService("Service", {
            resourceGroup: group.resourceGroupName,
            ...serviceProvider,
          });
          return { group, service };
        }),
      );
      const request = {
        subscriptionId: yield* subscription,
        resourceGroupName: group.resourceGroupName,
        peeringServiceName: service.peeringServiceName,
        connectionMonitorTestName: "probe",
      };
      const written = yield* peering.ConnectionMonitorTestsCreateOrUpdate({
        ...request,
        properties: {
          sourceAgent: "probe-agent",
          destination: "www.bing.com",
          destinationPort: 443,
          testFrequencyInSec: 30,
        },
      });
      expect(written.id).toBeUndefined();
      const observed = yield* peering.GetConnectionMonitorTest(request);
      expect(observed.id).toBeUndefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
