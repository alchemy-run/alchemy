// Coverage verdicts for the remaining `emr-containers` operations:
// - create/describe/list SecurityConfiguration: out of scope as a Resource —
//   the API has NO DeleteSecurityConfiguration, so a provisioned config can
//   never be destroyed (violates destroy/zero-orphan semantics); neither
//   Terraform nor CloudFormation models it. VirtualCluster accepts a
//   `securityConfigurationId` prop for configs created out of band.
// - create/delete ManagedEndpoint: resource lifecycle of an object that
//   requires a live EKS cluster + RUNNING virtual cluster + EMR Studio
//   setup; not modeled by Terraform/CloudFormation. The data plane is
//   covered (DescribeManagedEndpoint, ListManagedEndpoints,
//   GetManagedEndpointSessionCredentials).
// - tagResource/untagResource/listTagsForResource: covered by the
//   VirtualCluster/JobTemplate providers' tag sync.
export * from "./DescribeVirtualCluster.ts";
export * from "./GetManagedEndpointSessionCredentials.ts";
export * from "./JobRunEventSource.ts";
export * from "./JobTemplate.ts";
export * from "./StartJobRun.ts";
export * from "./VirtualCluster.ts";
export * from "./generated.ts";
