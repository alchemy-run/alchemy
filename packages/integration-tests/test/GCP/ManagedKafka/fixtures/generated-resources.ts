import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";
import { Brokers, Connect, Schemas } from "./bindings-host.ts";

/** Resources the generated ManagedKafka bindings bind: the suite's own fixtures and their children. */
export { Brokers, Connect, Events, Schemas } from "./bindings-host.ts";

export const ProbeAcl = Effect.gen(function* () {
  const cluster = yield* Brokers;
  return yield* GCP.ManagedKafka.ClustersAcl("ProbeAcl", {
    cluster: cluster.name,
    aclId: "topic/probe",
    aclEntries: [
      { principal: "User:*", operation: "DESCRIBE", permissionType: "ALLOW", host: "*" },
    ],
  });
});
export const ProbeSchemaVersion = Effect.gen(function* () {
  const registry = yield* Schemas;
  return yield* GCP.ManagedKafka.SchemaRegistriesSubjectsVersion("ProbeSchemaVersion", {
    schemaRegistry: registry.name,
    subject: "probe",
    schemaType: "AVRO",
    schema: JSON.stringify({
      type: "record",
      name: "Probe",
      namespace: "alchemy",
      fields: [{ name: "id", type: "string" }],
    }),
  });
});
export const ProbeConnector = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const connect = yield* Connect;
  const topic = yield* GCP.PubSub.Topic("ProbeConnectorSink", {});
  return yield* GCP.ManagedKafka.ConnectClustersConnector("ProbeConnector", {
    connectCluster: connect.name,
    configs: {
      "connector.class": "com.google.pubsub.kafka.sink.CloudPubSubSinkConnector",
      "tasks.max": "1",
      topics: "probe",
      "cps.project": project,
      "cps.topic": topic.topicId,
    },
  });
});
