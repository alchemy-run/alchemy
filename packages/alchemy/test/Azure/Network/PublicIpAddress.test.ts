import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  subscriptionId,
  tags,
  untilGone,
  withPublicIps,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getIp = (resourceGroupName: string, publicIpAddressName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetPublicIPAddress({
      subscriptionId,
      resourceGroupName,
      publicIpAddressName,
    }),
  );

// Standard static IPv4: ~$0.005/hour; the whole test runs for minutes.
const program = (props: {
  domainNameLabel?: string;
  idleTimeoutInMinutes: number;
  zones?: string[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ip = yield* Azure.Network.PublicIpAddress("Ingress", {
      resourceGroup: group.resourceGroupName,
      // The scope hashes the label per tenant, so it never collides with
      // other users' labels in the region.
      domainNameLabelScope:
        props.domainNameLabel === undefined ? undefined : "TenantReuse",
      domainNameLabel: props.domainNameLabel,
      idleTimeoutInMinutes: props.idleTimeoutInMinutes,
      zones: props.zones,
      tags: props.tags,
    });
    return { group, ip };
  });

test.provider(
  "create, update, replace, and delete a public IP address",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ip } = yield* stack.deploy(
        program({
          domainNameLabel: "alchemy-pip-a",
          idleTimeoutInMinutes: 4,
          tags: { env: "test" },
        }),
      );
      expect(ip.sku).toEqual("Standard");
      expect(ip.allocationMethod).toEqual("Static");
      expect(ip.ipAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(ip.fqdn).toMatch(
        /^alchemy-pip-a\..+\.eastus\..*cloudapp\.azure\.com$/,
      );
      const observed = yield* getIp(
        group.resourceGroupName,
        ip.publicIpAddressName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.dnsSettings?.domainNameLabel).toEqual(
        "alchemy-pip-a",
      );
      expect(observed.tags?.env).toEqual("test");

      // In place: idle timeout, DNS label, tags. The address is kept.
      const updated = yield* stack.deploy(
        program({
          domainNameLabel: "alchemy-pip-b",
          idleTimeoutInMinutes: 10,
          tags: { env: "prod" },
        }),
      );
      expect(updated.ip.publicIpAddressId).toEqual(ip.publicIpAddressId);
      expect(updated.ip.ipAddress).toEqual(ip.ipAddress);
      const reobserved = yield* getIp(
        group.resourceGroupName,
        ip.publicIpAddressName,
      );
      expect(reobserved.properties?.idleTimeoutInMinutes).toEqual(10);
      expect(reobserved.properties?.dnsSettings?.domainNameLabel).toEqual(
        "alchemy-pip-b",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: pin to zone 1 (zones are immutable).
      const replaced = yield* stack.deploy(
        program({
          idleTimeoutInMinutes: 10,
          zones: ["1"],
          tags: { env: "prod" },
        }),
      );
      expect(replaced.ip.publicIpAddressName).not.toEqual(
        ip.publicIpAddressName,
      );
      expect(replaced.ip.zones).toEqual(["1"]);
      expect(
        yield* untilGone(
          getIp(group.resourceGroupName, ip.publicIpAddressName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getIp(group.resourceGroupName, replaced.ip.publicIpAddressName),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(2), logLevel),
  { tags, timeout: 600_000 },
);
