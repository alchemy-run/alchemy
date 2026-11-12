import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";

/** The organization the credentials belong to, bound by the organization bindings. */
export const Org = ClickHouseCloud.Organization.Organization("BindingsOrg", {});

/** The smallest service, bound by the service bindings. */
export const Analytics = ClickHouseCloud.Service.Service("BindingsAnalytics", {
  provider: "aws",
  region: "us-east-1",
  ipAccessList: [{ source: "0.0.0.0/0", description: "bindings test" }],
  minReplicaMemoryGb: 8,
  maxReplicaMemoryGb: 8,
  numReplicas: 1,
  idleScaling: true,
  idleTimeoutMinutes: 5,
});
