import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";
import { Brokers, Connect, Events, Schemas } from "./bindings-host.ts";

/**
 * Managed Kafka resources the generated bindings bind: the bindings suite's
 * cluster, topic, Connect cluster and schema registry (~30 minutes each to
 * provision), plus an ACL, a connector and schema versions on them.
 */
export { Brokers, Connect, Events, Schemas };

const AVRO = JSON.stringify({
  type: "record",
  name: "Order",
  namespace: "alchemy",
  fields: [{ name: "id", type: "string" }],
});

export const ProbeAcl = Effect.gen(function* () {
  const cluster = yield* Brokers;
  return yield* GCP.ManagedKafka.ClustersAcl("ProbeAcl", {
    cluster: cluster.name,
    aclId: "topic/orders",
    aclEntries: [
      { principal: "User:*", operation: "DESCRIBE", permissionType: "ALLOW", host: "*" },
    ],
  });
});

export const ProbeConnector = Effect.gen(function* () {
  const project = yield* deployProject;
  const connect = yield* Connect;
  return yield* GCP.ManagedKafka.ConnectClustersConnector("ProbeConnector", {
    connectCluster: connect.name,
    configs: {
      "connector.class": "com.google.pubsub.kafka.sink.CloudPubSubSinkConnector",
      "tasks.max": "1",
      topics: "orders",
      "cps.project": project,
      "cps.topic": "alchemy-managedkafka-probe",
    },
  });
});

export const ProbeSubjectVersion = Effect.gen(function* () {
  const registry = yield* Schemas;
  return yield* GCP.ManagedKafka.SchemaRegistriesSubjectsVersion("ProbeSubjectVersion", {
    schemaRegistry: registry.name,
    subject: "orders",
    schemaType: "AVRO",
    schema: AVRO,
  });
});

export const ProbeContextSubjectVersion = Effect.gen(function* () {
  const registry = yield* Schemas;
  return yield* GCP.ManagedKafka.SchemaRegistriesContextsSubjectsVersion(
    "ProbeContextSubjectVersion",
    {
      schemaRegistry: registry.name,
      context: "dev",
      subject: "shipments",
      schemaType: "AVRO",
      schema: AVRO,
    },
  );
});
