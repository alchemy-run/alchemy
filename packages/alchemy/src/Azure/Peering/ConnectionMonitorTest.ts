import * as peering from "@distilled.cloud/azure/peering";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createPeeringName, peeringServiceOwnedByStage } from "./Common.ts";

export interface ConnectionMonitorTestProps {
  /** Resource group of the peering service. Changing it replaces the test. */
  resourceGroup: string;
  /** Peering service the test belongs to. Changing it replaces the test. */
  peeringService: string;
  /**
   * Name of the connection monitor test. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * test.
   */
  name?: string;
  /** Connection Monitor source agent (the Log Analytics agent name) the test runs from. */
  sourceAgent: string;
  /** Destination host name or IP address of the test. */
  destination: string;
  /** Destination TCP port of the test. */
  destinationPort: number;
  /**
   * How often the test runs, in seconds.
   * @default 30
   */
  testFrequencyInSec?: number;
}

export interface ConnectionMonitorTest extends Resource<
  "Azure.Peering.ConnectionMonitorTest",
  ConnectionMonitorTestProps,
  {
    /** Name of the connection monitor test. */
    connectionMonitorTestName: string;
    /** Peering service the test belongs to. */
    peeringService: string;
    /** Resource group of the peering service. */
    resourceGroup: string;
    /** ARM resource ID of the test. */
    connectionMonitorTestId: string;
    /** Source agent of the test. */
    sourceAgent: string;
    /** Destination of the test. */
    destination: string;
    /** Destination port of the test. */
    destinationPort: number;
    /** How often the test runs, in seconds. */
    testFrequencyInSec: number;
    /** Whether the last run of the test succeeded. */
    isTestSuccessful: boolean | undefined;
    /** Hops observed on the path to the destination. */
    path: string[];
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Connection Monitor test on an Azure Peering Service: measures latency
 * and reachability from a Log Analytics agent to a destination over the
 * peering service. The peering service must have Connection Monitor
 * initialized with a Log Analytics workspace; otherwise Azure accepts the
 * request but stores nothing, and the reconcile times out waiting for the
 * test.
 *
 * Tests have no tags; Alchemy treats a test as owned when its peering
 * service carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/peering-service/connection-telemetry
 *
 * ### Creating a Test
 * **Example:** Probe an HTTPS endpoint every 30 seconds
 * ```typescript
 * const test = yield* Azure.Peering.ConnectionMonitorTest("office-to-web", {
 *   resourceGroup: group.resourceGroupName,
 *   peeringService: service.peeringServiceName,
 *   sourceAgent: "office-agent-01",
 *   destination: "www.contoso.com",
 *   destinationPort: 443,
 * });
 * ```
 *
 * **Example:** Lower test frequency
 * ```typescript
 * const test = yield* Azure.Peering.ConnectionMonitorTest("office-to-dns", {
 *   resourceGroup: group.resourceGroupName,
 *   peeringService: service.peeringServiceName,
 *   sourceAgent: "office-agent-01",
 *   destination: "1.1.1.1",
 *   destinationPort: 53,
 *   testFrequencyInSec: 300,
 * });
 * ```
 *
 * @resource
 */
export const ConnectionMonitorTest = Resource<ConnectionMonitorTest>(
  "Azure.Peering.ConnectionMonitorTest",
);

const getTest = (
  subscriptionId: string,
  resourceGroupName: string,
  peeringServiceName: string,
  connectionMonitorTestName: string,
) =>
  orUndefinedIfNotFound(
    peering.GetConnectionMonitorTest({
      subscriptionId,
      resourceGroupName,
      peeringServiceName,
      connectionMonitorTestName,
    }),
  ).pipe(
    // Without Connection Monitor, Azure answers 200 with an empty body for
    // a test that does not exist.
    Effect.map((test) => (test?.id === undefined ? undefined : test)),
  );

const toAttrs = (
  resourceGroup: string,
  peeringService: string,
  name: string,
  test: peering.GetConnectionMonitorTestResponse,
): ConnectionMonitorTest["Attributes"] => ({
  connectionMonitorTestName: name,
  peeringService,
  resourceGroup,
  connectionMonitorTestId: test.id ?? "",
  sourceAgent: test.properties?.sourceAgent ?? "",
  destination: test.properties?.destination ?? "",
  destinationPort: test.properties?.destinationPort ?? 0,
  testFrequencyInSec: test.properties?.testFrequencyInSec ?? 0,
  isTestSuccessful: test.properties?.isTestSuccessful,
  path: test.properties?.path ?? [],
  provisioningState: test.properties?.provisioningState,
});

export const ConnectionMonitorTestProvider = () =>
  Provider.succeed(ConnectionMonitorTest, {
    stables: [
      "connectionMonitorTestName",
      "peeringService",
      "resourceGroup",
      "connectionMonitorTestId",
    ],

    // Tests live inside a peering service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.peeringService.toLowerCase() !==
          output.peeringService.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.connectionMonitorTestName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const peeringService = output?.peeringService ?? olds?.peeringService;
      if (resourceGroup === undefined || peeringService === undefined) {
        return undefined;
      }
      const name =
        output?.connectionMonitorTestName ??
        olds?.name ??
        (yield* createPeeringName(id));
      const observed = yield* getTest(
        subscriptionId,
        resourceGroup,
        peeringService,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, peeringService, name, observed);
      return (yield* peeringServiceOwnedByStage(
        subscriptionId,
        resourceGroup,
        peeringService,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Peering");
      const { resourceGroup, peeringService } = news;
      const name =
        news.name ??
        output?.connectionMonitorTestName ??
        (yield* createPeeringName(id));
      const desired = {
        sourceAgent: news.sourceAgent,
        destination: news.destination,
        destinationPort: news.destinationPort,
        testFrequencyInSec: news.testFrequencyInSec ?? 30,
      };
      const get = getTest(subscriptionId, resourceGroup, peeringService, name);

      // Observe.
      const observed = yield* get;
      const props = observed?.properties;

      // Ensure + sync: the PUT is a full upsert, skipped when the observed
      // test already matches.
      if (
        props === undefined ||
        props.sourceAgent !== desired.sourceAgent ||
        props.destination !== desired.destination ||
        props.destinationPort !== desired.destinationPort ||
        props.testFrequencyInSec !== desired.testFrequencyInSec
      ) {
        yield* peering.ConnectionMonitorTestsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          peeringServiceName: peeringService,
          connectionMonitorTestName: name,
          properties: desired,
        });
      }

      const fresh = yield* waitForProvisioned(
        `connection monitor test ${name}`,
        get,
        (test) => test.properties?.provisioningState,
        { times: 20 },
      );
      return toAttrs(resourceGroup, peeringService, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        peering.DeleteConnectionMonitorTest({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          peeringServiceName: output.peeringService,
          connectionMonitorTestName: output.connectionMonitorTestName,
        }),
      );
      yield* waitUntilGone(
        `connection monitor test ${output.connectionMonitorTestName}`,
        getTest(
          subscriptionId,
          output.resourceGroup,
          output.peeringService,
          output.connectionMonitorTestName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Peering.PeeringService",
      ],
    },
  });
