import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { developerGateway, logLevel, subscriptionId, tags } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const gatewayApis = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListGatewayApiByService({
      subscriptionId,
      resourceGroupName,
      serviceName,
      gatewayId: "alchemy-edge",
    }),
  ).pipe(Effect.map((page) => (page.value ?? []).map((a) => a.name ?? "")));

/** Poll until the gateway's APIs match `expected` (bounded). */
const untilApis = (
  resourceGroupName: string,
  serviceName: string,
  expected: string[],
) =>
  gatewayApis(resourceGroupName, serviceName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (names) => names.sort().join(",") === expected.sort().join(","),
      times: 10,
    }),
  );

const program = (target?: "one" | "two") =>
  Effect.gen(function* () {
    const { group, service, gateway } = yield* developerGateway;
    // Both APIs stay deployed across the replacement step.
    const one = yield* Azure.ApiManagement.Api("One", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-gw-one",
      path: "one",
      serviceUrl: "https://example.com",
    });
    const two = yield* Azure.ApiManagement.Api("Two", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-gw-two",
      path: "two",
      serviceUrl: "https://example.com",
    });
    const link = target
      ? yield* Azure.ApiManagement.GatewayApi("Served", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          gatewayName: gateway.gatewayName,
          apiName: target === "one" ? one.apiName : two.apiName,
        })
      : undefined;
    return { group, service, link };
  });

// Self-hosted gateways need the Developer (or Premium) tier: ~$0.07/h but
// 30-45 min to create (plus ~15 min to delete): est. ~$0.10 and ~60
// minutes per run.
test.provider.skipIf(!runExpensive)(
  "serve, replace, and remove an API on a self-hosted gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.link?.apiName).toEqual("alchemy-gw-one");
      expect(yield* untilApis(rg, svc, ["alchemy-gw-one"])).toEqual([
        "alchemy-gw-one",
      ]);

      // Replacement: another API is served, the old one is removed.
      yield* stack.deploy(program("two"));
      expect(yield* untilApis(rg, svc, ["alchemy-gw-two"])).toEqual([
        "alchemy-gw-two",
      ]);

      // Removing the resource stops serving the API.
      yield* stack.deploy(program());
      expect(yield* untilApis(rg, svc, [])).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
