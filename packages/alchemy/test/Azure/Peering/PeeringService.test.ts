import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as peering from "@distilled.cloud/azure/peering";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  serviceProvider,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  primary: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.Peering.PeeringService("Service", {
      resourceGroup: group.resourceGroupName,
      peeringServiceLocation: serviceProvider.peeringServiceLocation,
      peeringServiceProvider: serviceProvider.peeringServiceProvider,
      providerPrimaryPeeringLocation: props.primary,
      tags: props.tags,
    });
    return { group, service };
  });

const getService = (resourceGroupName: string, peeringServiceName: string) =>
  Effect.gen(function* () {
    return yield* peering.GetPeeringService({
      subscriptionId: yield* subscription,
      resourceGroupName,
      peeringServiceName,
    });
  });

// Peering services carry no Azure charge (the partner bills the
// connectivity) and provision synchronously in seconds.
test.provider(
  "create, update tags, replace, and delete a peering service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const first = yield* stack.deploy(
        program({ primary: "San Jose", tags: { env: "test" } }),
      );
      expect(first.service.provisioningState).toEqual("Succeeded");
      expect(first.service.peeringServiceProvider).toEqual("T-Mobile USA");
      const created = yield* getService(
        first.group.resourceGroupName,
        first.service.peeringServiceName,
      );
      expect(created.properties?.providerPrimaryPeeringLocation).toEqual(
        "San Jose",
      );
      expect(created.tags?.env).toEqual("test");
      expect(created.tags?.["alchemy::id"]).toEqual("Service");

      // Update tags in place.
      const second = yield* stack.deploy(
        program({ primary: "San Jose", tags: { env: "prod" } }),
      );
      expect(second.service.peeringServiceId).toEqual(
        first.service.peeringServiceId,
      );
      const updated = yield* getService(
        second.group.resourceGroupName,
        second.service.peeringServiceName,
      );
      expect(updated.tags?.env).toEqual("prod");

      // Replace: the provider peering location is immutable.
      const third = yield* stack.deploy(
        program({ primary: "Ashburn", tags: { env: "prod" } }),
      );
      expect(third.service.peeringServiceName).not.toEqual(
        first.service.peeringServiceName,
      );
      const replaced = yield* getService(
        third.group.resourceGroupName,
        third.service.peeringServiceName,
      );
      expect(replaced.properties?.providerPrimaryPeeringLocation).toEqual(
        "Ashburn",
      );
      expect(
        yield* waitGone(
          getService(
            first.group.resourceGroupName,
            first.service.peeringServiceName,
          ),
        ),
      ).toEqual("gone");

      // Delete.
      yield* stack.destroy();
      expect(
        yield* waitGone(
          getService(
            third.group.resourceGroupName,
            third.service.peeringServiceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
