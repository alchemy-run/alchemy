import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import { runPaidOnly } from "../gates.ts";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDscp = (resourceGroupName: string, dscpConfigurationName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetDscpConfiguration({
      subscriptionId,
      resourceGroupName,
      dscpConfigurationName,
    }),
  );

// DSCP configurations are free but the trial subscription rejects them
// ("DSCP Configuration is currently not supported"): the lifecycle runs only
// with AZURE_TEST_PAID=1.
const program = (props: { marking: number; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const dscp = yield* Azure.Network.DscpConfiguration("Voice", {
      resourceGroup: group.resourceGroupName,
      qosDefinitionCollection: [
        {
          markings: [props.marking],
          protocol: "Udp",
          sourceIpRanges: [{ startIP: "10.0.0.1", endIP: "10.0.0.10" }],
          destinationIpRanges: [{ startIP: "10.0.1.1", endIP: "10.0.1.10" }],
          sourcePortRanges: [{ start: 10000, end: 11000 }],
          destinationPortRanges: [{ start: 5060, end: 5061 }],
        },
      ],
      tags: { env: props.env },
    });
    return { group, dscp };
  });

test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a DSCP configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, dscp } = yield* stack.deploy(
        program({ marking: 46, env: "test" }),
      );
      const observed = yield* getDscp(
        group.resourceGroupName,
        dscp.dscpConfigurationName,
      );
      expect(
        observed.properties?.qosDefinitionCollection?.[0]?.markings,
      ).toEqual([46]);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ marking: 34, env: "prod" }),
      );
      expect(updated.dscp.dscpConfigurationId).toEqual(
        dscp.dscpConfigurationId,
      );
      const reobserved = yield* getDscp(
        group.resourceGroupName,
        dscp.dscpConfigurationName,
      );
      expect(
        reobserved.properties?.qosDefinitionCollection?.[0]?.markings,
      ).toEqual([34]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getDscp(group.resourceGroupName, dscp.dscpConfigurationName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

test.provider(
  "DSCP configurations are rejected with a typed error on the trial",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sub = yield* subscriptionId;
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("ProbeGroup", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* network
        .DscpConfigurationCreateOrUpdate({
          subscriptionId: sub,
          resourceGroupName: group.resourceGroupName,
          dscpConfigurationName: "dscp-probe",
          location: "eastus",
          properties: { markings: [46], protocol: "Udp" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NetworkFeatureNotSupported");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
