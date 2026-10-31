import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** DataMigration resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeConnectionProfile = GCP.DataMigration.ConnectionProfile(
  "ProbeConnectionProfile",
  {
    location: "us-central1",
    displayName: "mysql-src",
    mysql: {
      host: "10.0.0.8",
      port: 3306,
      username: "alchemy",
      password: "AlchemyTestPass1",
    },
  },
);
export const ProbeConversionWorkspace = GCP.DataMigration.ConversionWorkspace(
  "ProbeConversionWorkspace",
  {
    location: "us-central1",
    displayName: "oracle-to-pg",
    source: { engine: "ORACLE", version: "11" },
    destination: { engine: "POSTGRESQL", version: "14" },
    globalSettings: { skip_triggers: "false" },
  },
);

const PeeringVpc = GCP.Compute.Network("ProbeDmsVpc", { autoCreateSubnetworks: false });
export const ProbePrivateConnection = Effect.gen(function* () {
  const network = yield* PeeringVpc;
  return yield* GCP.DataMigration.PrivateConnection("ProbePrivateConnection", {
    location: "us-central1",
    displayName: "probe-dms-peer",
    skipValidation: true,
    vpcPeeringConfig: { vpcName: network.networkName, subnet: "10.8.9.0/29" },
  });
});
export const ProbeMappingRule = Effect.gen(function* () {
  const workspace = yield* ProbeConversionWorkspace;
  return yield* GCP.DataMigration.ConversionWorkspacesMappingRule("ProbeMappingRule", {
    conversionWorkspace: workspace.name,
    location: "us-central1",
    displayName: "rename-schema",
    ruleScope: "DATABASE_ENTITY_TYPE_SCHEMA",
    ruleOrder: "1000",
    filter: { entities: ["src_schema"] },
    singleEntityRename: { newName: "dst_schema" },
  });
});
