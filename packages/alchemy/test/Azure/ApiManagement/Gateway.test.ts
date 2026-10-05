import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import {
  developerService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGateway = (
  resourceGroupName: string,
  serviceName: string,
  gatewayId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetGateway({
      subscriptionId,
      resourceGroupName,
      serviceName,
      gatewayId,
    }),
  );

const program = (gateway?: { name: string; city: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* developerService;
    const created = gateway
      ? yield* Azure.ApiManagement.Gateway("Edge", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: gateway.name,
          locationData: { name: "dc1", city: gateway.city },
          description: "Self-hosted test gateway",
        })
      : undefined;
    return { group, service, gateway: created };
  });

// Self-hosted gateways need the Developer (or Premium) tier. A Developer
// service costs ~$0.07/h but takes 30-45 min to create (plus ~15 min to
// delete): est. ~$0.10 and ~60 minutes per run. Only the registration is
// tested; no gateway container is run.
test.provider.skipIf(!runExpensive)(
  "register, update, replace, and delete a self-hosted gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-edge", city: "Seattle" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.gateway?.gatewayName).toEqual("alchemy-edge");
      expect(
        first.gateway?.primaryKey && Redacted.value(first.gateway.primaryKey),
      ).toBeTruthy();
      const observed = yield* getGateway(rg, svc, "alchemy-edge");
      expect(observed.properties?.locationData?.city).toEqual("Seattle");

      // In-place update of the location metadata.
      yield* stack.deploy(program({ name: "alchemy-edge", city: "Portland" }));
      expect(
        (yield* getGateway(rg, svc, "alchemy-edge")).properties?.locationData
          ?.city,
      ).toEqual("Portland");

      // Replacement: a new identifier creates a new gateway and deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-edge-v2", city: "Portland" }),
      );
      expect(replaced.gateway?.gatewayName).toEqual("alchemy-edge-v2");
      expect(yield* untilGone(getGateway(rg, svc, "alchemy-edge"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the gateway.
      yield* stack.deploy(program());
      expect(yield* untilGone(getGateway(rg, svc, "alchemy-edge-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
