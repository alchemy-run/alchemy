# AWS SageMaker HyperPod Example

A minimal SageMaker HyperPod training cluster, fully TypeScript-driven.

- [`src/infra.ts`](./src/infra.ts) — the lifecycle-script bucket and the
  instance execution role. The role gets the AWS-managed cluster-instance
  policy plus an inline grant on the bucket, built with
  `Output.interpolate` over the bucket's ARN.
- [`src/lifecycle.ts`](./src/lifecycle.ts) — a deploy-time `Alchemy.Action`
  that uploads `on_create.sh` to the bucket with the Effect-native distilled
  SDK (`s3.putObject`). Its input captures the bucket's name and its output
  feeds the cluster, so bucket → script → cluster ordering is inferred from
  the data flow.
- [`alchemy.run.ts`](./alchemy.run.ts) — the Slurm-orchestrated
  `AWS.SageMaker.Cluster` with a single `ml.t3.medium` instance group. Swap
  in `ml.g5`/`ml.p5` groups for real distributed training; instance groups
  are updated in place, and removing one from `instanceGroups` deletes it
  from the cluster.

## Commands

```sh
bun install
bun run --filter aws-hyperpod-example deploy
bun run --filter aws-hyperpod-example destroy
```

Provisioning takes ~5 minutes at this size (10–25 minutes for large GPU
groups).

## Task governance

EKS-orchestrated HyperPod clusters (`orchestrator: { Eks: { ClusterArn } }`)
can also carry task-governance resources — a scheduler policy and per-team
compute quotas:

```typescript
const policy = yield* AWS.SageMaker.ClusterSchedulerConfig("Scheduler", {
  clusterArn: cluster.clusterArn,
  schedulerConfig: {
    PriorityClasses: [
      { Name: "inference", Weight: 100 },
      { Name: "training", Weight: 75 },
    ],
    FairShare: "Enabled",
  },
});

const quota = yield* AWS.SageMaker.ComputeQuota("ResearchQuota", {
  clusterArn: cluster.clusterArn,
  computeQuotaTarget: { TeamName: "research", FairShareWeight: 20 },
  computeQuotaConfig: {
    ComputeQuotaResources: [{ InstanceType: "ml.g5.xlarge", Count: 2 }],
    ResourceSharingConfig: { Strategy: "LendAndBorrow", BorrowLimit: 50 },
  },
});
```

## Optional inspection

```sh
aws sagemaker describe-cluster --cluster-name <clusterName output>
aws sagemaker list-cluster-nodes --cluster-name <clusterName output>
```
