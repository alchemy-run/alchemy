import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import {
  developerGateway,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";
import { PFX_ONE, PFX_PASSWORD } from "./certificates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfig = (
  resourceGroupName: string,
  serviceName: string,
  hcId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetGatewayHostnameConfiguration({
      subscriptionId,
      resourceGroupName,
      serviceName,
      gatewayId: "alchemy-edge",
      hcId,
    }),
  );

const program = (config?: { name: string; http2Enabled: boolean }) =>
  Effect.gen(function* () {
    const { group, service, gateway } = yield* developerGateway;
    const tls = yield* Azure.ApiManagement.Certificate("Tls", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-tls",
      data: Redacted.make(PFX_ONE),
      password: Redacted.make(PFX_PASSWORD),
    });
    const created = config
      ? yield* Azure.ApiManagement.GatewayHostnameConfiguration("Host", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          gatewayName: gateway.gatewayName,
          name: config.name,
          hostname: `${config.name}.example.com`,
          certificateId: tls.certificateId,
          http2Enabled: config.http2Enabled,
        })
      : undefined;
    return { group, service, config: created };
  });

// Self-hosted gateways need the Developer (or Premium) tier: ~$0.07/h but
// 30-45 min to create (plus ~15 min to delete): est. ~$0.10 and ~60
// minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a gateway hostname configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-host", http2Enabled: false }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.config?.hostname).toEqual("alchemy-host.example.com");
      expect(
        (yield* getConfig(rg, svc, "alchemy-host")).properties?.http2Enabled,
      ).toEqual(false);

      // In-place update: enable HTTP/2.
      yield* stack.deploy(
        program({ name: "alchemy-host", http2Enabled: true }),
      );
      expect(
        (yield* getConfig(rg, svc, "alchemy-host")).properties?.http2Enabled,
      ).toEqual(true);

      // Replacement: a new identifier creates a new configuration.
      yield* stack.deploy(
        program({ name: "alchemy-host2", http2Enabled: true }),
      );
      expect(
        (yield* getConfig(rg, svc, "alchemy-host2")).properties?.hostname,
      ).toEqual("alchemy-host2.example.com");
      expect(yield* untilGone(getConfig(rg, svc, "alchemy-host"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the configuration.
      yield* stack.deploy(program());
      expect(yield* untilGone(getConfig(rg, svc, "alchemy-host2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
