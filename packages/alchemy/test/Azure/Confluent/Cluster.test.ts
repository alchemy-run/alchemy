import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as confluent from "@distilled.cloud/azure/confluent";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  logLevel,
  organizationStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCluster = (
  resourceGroupName: string,
  organizationName: string,
  environmentId: string,
  clusterId: string,
) =>
  Effect.gen(function* () {
    return yield* confluent.GetOrganizationClusterById({
      subscriptionId: yield* subscription,
      resourceGroupName,
      organizationName,
      environmentId,
      clusterId,
    });
  });

const program = (
  displayName: string,
  availability: Azure.Confluent.ClusterAvailability,
) =>
  Effect.gen(function* () {
    const parents = yield* organizationStack;
    const cluster = yield* Azure.Confluent.Cluster("Cluster", {
      resourceGroup: parents.group.resourceGroupName,
      organization: parents.organization.organizationName,
      environment: parents.environment.environmentId,
      displayName,
      availability,
      kind: "Basic",
      region: "eastus",
    });
    return { ...parents, cluster };
  });

// Needs a Confluent organization (Marketplace SaaS purchase, blocked on the
// free trial). A Basic cluster bills only for usage (well under $1 for a
// short run); ~15 minutes with the organization. Run only with
// AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a confluent cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, organization, environment, cluster } = yield* stack.deploy(
        program("events", "SINGLE_ZONE"),
      );
      expect(cluster.phase).toEqual("PROVISIONED");
      expect(cluster.kafkaBootstrapEndpoint).toBeDefined();
      const observed = yield* getCluster(
        group.resourceGroupName,
        organization.organizationName,
        environment.environmentId,
        cluster.clusterId,
      );
      expect(observed.properties?.spec?.name).toEqual("events");

      // In-place: display name.
      const updated = yield* stack.deploy(
        program("events-renamed", "SINGLE_ZONE"),
      );
      expect(updated.cluster.clusterResourceId).toEqual(
        cluster.clusterResourceId,
      );
      expect(
        (yield* getCluster(
          group.resourceGroupName,
          organization.organizationName,
          environment.environmentId,
          cluster.clusterId,
        )).properties?.spec?.name,
      ).toEqual("events-renamed");

      // Replacement: availability is immutable.
      const replaced = yield* stack.deploy(
        program("events-renamed", "MULTI_ZONE"),
      );
      expect(replaced.cluster.availability).toEqual("MULTI_ZONE");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCluster(
            group.resourceGroupName,
            organization.organizationName,
            environment.environmentId,
            replaced.cluster.clusterId,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
