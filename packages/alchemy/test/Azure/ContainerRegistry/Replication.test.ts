import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  basicRegistry,
  getRegistry,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getReplication = (
  resourceGroupName: string,
  registryName: string,
  replicationName: string,
) =>
  Effect.gen(function* () {
    return yield* containerregistry.GetReplication({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
      replicationName,
    });
  });

const program = (props: {
  location: string;
  regionEndpointEnabled: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, registry } = yield* basicRegistry("Premium");
    const replication = yield* Azure.ContainerRegistry.Replication("Replica", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      location: props.location,
      regionEndpointEnabled: props.regionEndpointEnabled,
      tags: props.tags,
    });
    return { group, registry, replication };
  });

// Premium registry (~$1.67/day) plus one replica per step (~$1.67/day
// each), billed per day: ~$3-5 per run; each replica takes 2-5 minutes to
// provision and delete.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a replication",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, replication } = yield* stack.deploy(
        program({
          location: "westus2",
          regionEndpointEnabled: true,
          tags: { env: "test" },
        }),
      );
      const get = (name: string) =>
        getReplication(group.resourceGroupName, registry.registryName, name);
      const observed = yield* get(replication.replicationName);
      expect(observed.location).toEqual("westus2");
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.regionEndpointEnabled).toEqual(true);
      expect(observed.tags?.env).toEqual("test");

      // In-place: disable the regional endpoint and retag.
      const updated = yield* stack.deploy(
        program({
          location: "westus2",
          regionEndpointEnabled: false,
          tags: { env: "prod" },
        }),
      );
      expect(updated.replication.replicationId).toEqual(
        replication.replicationId,
      );
      const reobserved = yield* get(replication.replicationName);
      expect(reobserved.properties?.regionEndpointEnabled).toEqual(false);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "centralus",
          regionEndpointEnabled: true,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.replication.replicationName).not.toEqual(
        replication.replicationName,
      );
      const replacedObserved = yield* get(replaced.replication.replicationName);
      expect(replacedObserved.location).toEqual("centralus");
      expect(yield* waitGone(get(replication.replicationName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
