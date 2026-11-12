import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";

/** The smallest service: one 8 GB replica that idles after 5 minutes. */
export const small = {
  provider: "aws" as const,
  region: "us-east-1" as const,
  minReplicaMemoryGb: 8,
  maxReplicaMemoryGb: 8,
  numReplicas: 1,
  idleScaling: true,
  idleTimeoutMinutes: 5,
};

/** The organization the credentials belong to, bound by the organization bindings. */
export const Org = ClickHouseCloud.Organization.Organization("BindingsOrg", {});

/** The smallest service, bound by the service bindings. */
export const Analytics = ClickHouseCloud.Service.Service("BindingsAnalytics", {
  ...small,
  ipAccessList: [{ source: "0.0.0.0/0", description: "bindings test" }],
});
