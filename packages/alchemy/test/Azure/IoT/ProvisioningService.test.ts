import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dps from "@distilled.cloud/azure/deviceprovisioningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (
  resourceGroupName: string,
  provisioningServiceName: string,
) =>
  Effect.gen(function* () {
    return yield* dps.GetIotDpsResource({
      subscriptionId: yield* subscription,
      resourceGroupName,
      provisioningServiceName,
    });
  });

const program = (props: {
  location: string;
  tags: Record<string, string>;
  allocationPolicy?: "Hashed" | "GeoLatency" | "Static";
  ipFilterRules?: Azure.IoT.ProvisioningServiceProps["ipFilterRules"];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.IoT.ProvisioningService("Dps", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      allocationPolicy: props.allocationPolicy,
      ipFilterRules: props.ipFilterRules,
      tags: props.tags,
    });
    return { group, service };
  });

// DPS S1 has no fixed fee (billed per 1,000 operations): ~$0. ~3-5 minutes.
test.provider(
  "create, update, replace, and delete a device provisioning service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(service.state).toEqual("Active");
      expect(service.idScope).toMatch(/^0ne/i);
      expect(service.deviceProvisioningHostName).toEqual(
        "global.azure-devices-provisioning.net",
      );
      expect(service.tags).toEqual({ env: "test" });
      expect(service.primaryConnectionString).toBeDefined();
      expect(Redacted.value(service.primaryConnectionString!)).toContain(
        "SharedAccessKeyName=provisioningserviceowner",
      );
      const observed = yield* getService(rg, service.provisioningServiceName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toBeDefined();
      expect(observed.properties.idScope).toEqual(service.idScope);

      // In place: tags, allocation policy, and IP filter rules.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          tags: { env: "updated" },
          allocationPolicy: "GeoLatency",
          ipFilterRules: [
            {
              filterName: "office",
              action: "Accept",
              ipMask: "203.0.113.0/24",
            },
          ],
        }),
      );
      expect(updated.service.provisioningServiceId).toEqual(
        service.provisioningServiceId,
      );
      expect(updated.service.idScope).toEqual(service.idScope);
      expect(updated.service.allocationPolicy).toEqual("GeoLatency");
      const reobserved = yield* getService(rg, service.provisioningServiceName);
      expect(reobserved.tags?.env).toEqual("updated");
      expect(reobserved.properties.allocationPolicy).toEqual("GeoLatency");
      expect(
        reobserved.properties.ipFilterRules?.map((rule) => rule.ipMask),
      ).toEqual(["203.0.113.0/24"]);

      // Replacement: location.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          tags: { env: "updated" },
          allocationPolicy: "GeoLatency",
        }),
      );
      expect(replaced.service.location.toLowerCase()).toEqual("westus2");
      expect(replaced.service.provisioningServiceName).not.toEqual(
        service.provisioningServiceName,
      );
      expect(
        yield* waitGone(getService(rg, service.provisioningServiceName)),
      ).toEqual("gone");
      expect(
        (yield* getService(
          rg,
          replaced.service.provisioningServiceName,
        )).location.toLowerCase(),
      ).toEqual("westus2");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getService(rg, replaced.service.provisioningServiceName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
