import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/** A BigQuery destination profile for the generated Datastream bindings. */
export const ProbeProfile = GCP.Datastream.ConnectionProfile("ProbeProfile", {
  location: "us-central1",
  displayName: "probe-bq",
  bigqueryProfile: {},
});

export const ProbeSource = GCP.Datastream.ConnectionProfile("ProbeSource", {
  location: "us-central1",
  displayName: "probe-mysql",
  mysqlProfile: {
    hostname: "10.0.0.8",
    port: 3306,
    username: "alchemy",
    password: "AlchemyProbePass1",
  },
  staticServiceIpConnectivity: {},
  force: true,
});
export const ProbeStream = Effect.gen(function* () {
  const project = yield* deployProject;
  const source = yield* ProbeSource;
  const dest = yield* ProbeProfile;
  return yield* GCP.Datastream.Stream("ProbeStream", {
    location: "us-central1",
    displayName: "probe-stream",
    sourceConfig: {
      sourceConnectionProfile: source.name,
      mysqlSourceConfig: { includeObjects: { mysqlDatabases: [{ database: "alchemy" }] } },
    },
    destinationConfig: {
      destinationConnectionProfile: dest.name,
      bigqueryDestinationConfig: {
        singleTargetDataset: { datasetId: `${project}:alchemy_probe_ds` },
        dataFreshness: "900s",
      },
    },
    backfillNone: {},
    force: true,
  });
});
const PeeringVpc = GCP.Compute.Network("ProbeDatastreamVpc", { autoCreateSubnetworks: false });
export const ProbePrivateConnection = Effect.gen(function* () {
  const network = yield* PeeringVpc;
  return yield* GCP.Datastream.PrivateConnection("ProbePrivateConnection", {
    location: "us-central1",
    displayName: "probe-peer",
    force: true,
    vpcPeeringConfig: { vpc: network.networkName, subnet: "10.9.9.0/29" },
  });
});
export const ProbeRoute = Effect.gen(function* () {
  const peering = yield* ProbePrivateConnection;
  return yield* GCP.Datastream.PrivateConnectionsRoute("ProbeRoute", {
    privateConnection: peering.name,
    location: "us-central1",
    displayName: "probe-db-host",
    destinationAddress: "10.0.0.8",
    destinationPort: 3306,
  });
});
