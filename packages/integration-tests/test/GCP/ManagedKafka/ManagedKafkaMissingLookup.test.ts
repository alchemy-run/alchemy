import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:managedkafka", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const underscored = name.replace(/-/g, "_");
      yield* expectAllMissing(stack, {
        "missing-cluster": GCP.ManagedKafka.Cluster.lookup({ clusterId: name }).name,
        "missing-clusters-acl": GCP.ManagedKafka.ClustersAcl.lookup({ aclId: name, cluster: name })
          .name,
        "missing-clusters-topic": GCP.ManagedKafka.ClustersTopic.lookup({
          topicId: name,
          cluster: name,
        }).name,
        "missing-connect-cluster": GCP.ManagedKafka.ConnectCluster.lookup({
          connectClusterId: name,
        }).name,
        "missing-connect-clusters-connector": GCP.ManagedKafka.ConnectClustersConnector.lookup({
          connectorId: name,
          connectCluster: name,
        }).name,
        "missing-schema-registries-subjects-version":
          GCP.ManagedKafka.SchemaRegistriesSubjectsVersion.lookup({
            subject: underscored,
            schemaRegistry: underscored,
          }).name,
        "missing-schema-registry": GCP.ManagedKafka.SchemaRegistry.lookup({
          schemaRegistryId: underscored,
        }).name,
      });
    }),
  { tags, timeout: 165000 },
);
