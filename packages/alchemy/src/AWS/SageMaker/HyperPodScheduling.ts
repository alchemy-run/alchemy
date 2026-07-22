/**
 * Typed scheduling metadata for running Kubernetes workloads on a SageMaker
 * HyperPod cluster orchestrated by EKS.
 *
 * HyperPod nodes are ordinary EKS nodes with well-known labels, and HyperPod
 * task governance rides on Kueue conventions. This helper turns the
 * stringly-typed conventions into a typed fragment consumed by
 * `AWS.EKS.Job` / `AWS.EKS.Deployment` (or a raw `AWS.EKS.Manifest`).
 */

/** The well-known node label carrying the HyperPod instance-group name. */
export const HYPERPOD_INSTANCE_GROUP_LABEL =
  "sagemaker.amazonaws.com/instance-group-name";

/** The well-known node label carrying HyperPod's node health verdict. */
export const HYPERPOD_NODE_HEALTH_LABEL =
  "sagemaker.amazonaws.com/node-health-status";

/** Kueue label selecting the task-governance queue. */
export const KUEUE_QUEUE_NAME_LABEL = "kueue.x-k8s.io/queue-name";

/** Kueue label selecting the task-governance priority class. */
export const KUEUE_PRIORITY_CLASS_LABEL = "kueue.x-k8s.io/priority-class";

export interface HyperPodSchedulingProps {
  /**
   * Pin the workload to a HyperPod instance group (matches the
   * `sagemaker.amazonaws.com/instance-group-name` node label).
   */
  instanceGroup?: string;
  /**
   * Only schedule onto nodes that passed HyperPod health checks
   * (`sagemaker.amazonaws.com/node-health-status: Schedulable`). Deep
   * health checks taint unhealthy nodes as well, but the selector keeps
   * pods off nodes that are mid-check.
   * @default true
   */
  healthyNodesOnly?: boolean;
  /**
   * Submit through HyperPod task governance as this team. Sets the Kueue
   * queue label to `hyperpod-ns-<team>-localqueue` and targets the
   * `hyperpod-ns-<team>` namespace — both are created automatically when an
   * `AWS.SageMaker.ComputeQuota` for the team is created.
   */
  team?: string;
  /**
   * The task-governance priority class (a `PriorityClass` name from the
   * cluster's `AWS.SageMaker.ClusterSchedulerConfig`). Sets the Kueue
   * priority label to `<priorityClass>-priority`.
   */
  priorityClass?: string;
  /**
   * Additional node-selector terms merged into the result (e.g.
   * `{ "node.kubernetes.io/instance-type": "ml.g5.xlarge" }`, or custom
   * labels declared on the instance group via `KubernetesConfig.Labels`).
   */
  nodeSelector?: Record<string, string>;
}

export interface HyperPodScheduling {
  /**
   * The task-governance team namespace (`hyperpod-ns-<team>`), or undefined
   * when no team is set. Pass as the workload's `namespace`.
   */
  namespace: string | undefined;
  /**
   * Kueue labels for the workload object. Pass as (or merge into) the
   * workload's `labels`.
   */
  labels: Record<string, string>;
  /**
   * Pod-template fragment carrying the node selector. Pass as (or
   * deep-merge into) the workload's `podTemplate`.
   */
  podTemplate: { spec: { nodeSelector: Record<string, string> } };
}

/**
 * Build the scheduling metadata that places a Kubernetes workload onto a
 * HyperPod cluster's nodes — healthy nodes only, optionally pinned to an
 * instance group, and optionally arbitrated by HyperPod task governance
 * (team quota + priority class).
 *
 * ```typescript
 * const train = yield* AWS.EKS.Job("Train", {
 *   cluster: eks, // the HyperPod cluster's orchestrator
 *   image: "ghcr.io/acme/train:v3",
 *   ...AWS.SageMaker.hyperpodScheduling({
 *     instanceGroup: "workers",
 *     team: "research",
 *     priorityClass: "training",
 *   }),
 * });
 * ```
 */
export const hyperpodScheduling = (
  props: HyperPodSchedulingProps = {},
): HyperPodScheduling => {
  const nodeSelector: Record<string, string> = {
    ...(props.healthyNodesOnly !== false
      ? { [HYPERPOD_NODE_HEALTH_LABEL]: "Schedulable" }
      : {}),
    ...(props.instanceGroup !== undefined
      ? { [HYPERPOD_INSTANCE_GROUP_LABEL]: props.instanceGroup }
      : {}),
    ...props.nodeSelector,
  };
  return {
    namespace:
      props.team !== undefined ? `hyperpod-ns-${props.team}` : undefined,
    labels: {
      ...(props.team !== undefined
        ? {
            [KUEUE_QUEUE_NAME_LABEL]: `hyperpod-ns-${props.team}-localqueue`,
          }
        : {}),
      ...(props.priorityClass !== undefined
        ? { [KUEUE_PRIORITY_CLASS_LABEL]: `${props.priorityClass}-priority` }
        : {}),
    },
    podTemplate: { spec: { nodeSelector } },
  };
};
