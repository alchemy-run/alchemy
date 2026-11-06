import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails } from "../lookup.ts";
import { expectLookupConsumers } from "./lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
});

const tags = ["provider:gcp", "live"];

// The targets belong to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "GcpLookupTarget",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.Bucket("lookup-bucket", {});
    const topic = yield* GCP.PubSub.Topic("lookup-topic", {});
    const subscription = yield* GCP.PubSub.Subscription("lookup-subscription", {
      topic: topic.name,
    });
    const serviceAccount = yield* GCP.IAM.ServiceAccount("lookup-sa", {});
    const network = yield* GCP.Compute.Network("lookup-vpc", { autoCreateSubnetworks: false });
    const subnetwork = yield* GCP.Compute.Subnetwork("lookup-subnet", {
      network: network.networkName,
      ipCidrRange: "10.42.0.0/24",
    });
    const firewall = yield* GCP.Compute.Firewall("lookup-firewall", {
      network: network.networkName,
      allowed: [{ protocol: "tcp", ports: ["22"] }],
      sourceRanges: ["10.42.0.0/24"],
    });
    const repository = yield* GCP.ArtifactRegistry.Repository("lookup-repo", {
      format: "DOCKER",
    });
    const dataset = yield* GCP.BigQuery.Dataset("lookup-dataset", {});
    return {
      bucketName: bucket.bucketName.as<string>(),
      bucketSelfLink: bucket.selfLink.as<string>(),
      topicId: topic.topicId.as<string>(),
      topicName: topic.name.as<string>(),
      subscriptionId: subscription.subscriptionId.as<string>(),
      subscriptionTopic: subscription.topic.as<string>(),
      accountId: serviceAccount.accountId.as<string>(),
      email: serviceAccount.email.as<string>(),
      networkName: network.networkName.as<string>(),
      networkSelfLink: network.selfLink.as<string>(),
      subnetworkName: subnetwork.subnetworkName.as<string>(),
      region: subnetwork.region.as<string>(),
      ipCidrRange: subnetwork.ipCidrRange.as<string>(),
      firewallName: firewall.firewallName.as<string>(),
      firewallNetwork: firewall.network.as<string>(),
      repositoryId: repository.repositoryId.as<string>(),
      location: repository.location.as<string>(),
      registryUri: repository.registryUri.as<string>(),
      datasetId: dataset.datasetId.as<string>(),
      datasetName: dataset.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack), { timeout: 300_000 });

test.provider(
  "looked-up resources resolve by their ids, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const t = yield* target;

      yield* expectLookupConsumers(
        stack,
        () => ({
          bucket: GCP.Storage.Bucket.lookup({ bucketName: t.bucketName }).selfLink.as<string>(),
          topic: GCP.PubSub.Topic.lookup({ topicId: t.topicId }).name,
          subscription: GCP.PubSub.Subscription.lookup({ subscriptionId: t.subscriptionId }).topic,
          sa: GCP.IAM.ServiceAccount.lookup({ accountId: t.accountId }).email,
          network: GCP.Compute.Network.lookup({ networkName: t.networkName }).selfLink.as<string>(),
          subnetwork: GCP.Compute.Subnetwork.lookup({
            subnetworkName: t.subnetworkName,
            region: t.region,
          }).ipCidrRange,
          firewall: GCP.Compute.Firewall.lookup({ firewallName: t.firewallName }).network,
          repository: GCP.ArtifactRegistry.Repository.lookup({
            repositoryId: t.repositoryId,
            location: t.location,
          }).registryUri.as<string>(),
          dataset: GCP.BigQuery.Dataset.lookup({ datasetId: t.datasetId }).name,
        }),
        {
          bucket: t.bucketSelfLink,
          topic: t.topicName,
          subscription: t.subscriptionTopic,
          sa: t.email,
          network: t.networkSelfLink,
          subnetwork: t.ipCidrRange,
          firewall: t.firewallNetwork,
          repository: t.registryUri,
          dataset: t.datasetName,
        },
      );

      const topic = yield* pubsub.getProjectsTopics({ topic: t.topicName });
      expect(topic.name).toBe(t.topicName);
      const bucket = yield* storage.getBuckets({ bucket: t.bucketName });
      expect(bucket.name).toBe(t.bucketName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup reads the project its props name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { project } = yield* GcpEnvironment.current;
      const { topicId, topicName } = yield* target;

      yield* expectLookupConsumers(
        stack,
        () => ({
          topic: GCP.PubSub.Topic.lookup({ topicId, project }).name,
          project: GCP.ResourceManager.Project.lookup({ projectId: project }).projectId,
        }),
        { topic: topicName, project },
      );
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a topic this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => GCP.PubSub.Topic("lookup-managed", {});
      const { topicId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* GCP.SecretManager.Secret("managed-topic-consumer", {
              annotations: { value: GCP.PubSub.Topic.lookup({ topicId }).name },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);
