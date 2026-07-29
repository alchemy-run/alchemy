/**
 * First-class SageMaker HyperPod scheduling for EKS workloads.
 *
 * HyperPod nodes are ordinary EKS nodes carrying well-known labels, and
 * HyperPod task governance rides on Kueue conventions. Spread
 * {@link hyperpod} into a `Kubernetes.Job` / `Kubernetes.Deployment`'s
 * props to derive the node selector, namespace, and Kueue labels — no
 * manual label wiring:
 *
 * ```ts
 * const train = yield* Kubernetes.Job("Train", {
 *   cluster,
 *   main: import.meta.url,
 *   ...AWS.EKS.hyperpod({
 *     quota,
 *     instanceGroup: hyperpodCluster.instanceGroups.workers,
 *   }),
 * });
 * ```
 */
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";

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

export interface HyperPodWorkloadProps {
  /**
   * Pin the workload to a HyperPod instance group (matches the
   * `sagemaker.amazonaws.com/instance-group-name` node label). Reference
   * the group through the cluster's attributes —
   * `hyperpod.instanceGroups.workers` — so the workload is connected to
   * the cluster through the resource graph. A plain name string also
   * works.
   */
  instanceGroup?: Input<string> | { InstanceGroupName?: Input<string> };
  /**
   * Only schedule onto nodes that passed HyperPod health checks
   * (`sagemaker.amazonaws.com/node-health-status: Schedulable`).
   * @default true
   */
  healthyNodesOnly?: boolean;
  /**
   * Submit through HyperPod task governance under this team's quota — pass
   * the `AWS.SageMaker.ComputeQuota` resource. Derives the
   * `hyperpod-ns-<team>` namespace and the Kueue queue label (both
   * materialized by the quota), and orders the workload after it.
   */
  quota?: {
    /** The quota's team name (`ComputeQuota.teamName`). */
    teamName: Input<string>;
  };
  /**
   * The task-governance priority class (a `PriorityClass` name from the
   * cluster's `AWS.SageMaker.ClusterSchedulerConfig`).
   */
  priorityClass?: Input<string>;
}

/** @internal The instance-group name from either reference form. */
const instanceGroupName = (
  group: Input<string> | { InstanceGroupName?: Input<string> } | undefined,
): Input<string> | undefined =>
  group === undefined || typeof group === "string" || Output.isOutput(group)
    ? (group as Input<string> | undefined)
    : (group as { InstanceGroupName?: Input<string> }).InstanceGroupName;

/**
 * Interpolate around a value that may be an unresolved Output (a resource
 * attribute) — plain strings stay plain so props remain readable in plans.
 */
const affix = (
  prefix: string,
  value: Input<string>,
  suffix: string,
): Input<string> =>
  typeof value === "string"
    ? `${prefix}${value}${suffix}`
    : Output.interpolate`${prefix}${value as Output.Output<string>}${suffix}`;

/**
 * Derive the `Kubernetes.Deployment` / `Kubernetes.Job` props that run a
 * workload on SageMaker HyperPod nodes: the HyperPod node selector (as a
 * `podTemplate` fragment), Kueue task-governance labels, and — when
 * governed by a `quota` — the `hyperpod-ns-<team>` namespace. Spread the
 * result into the workload's props; the workload merges the labels over
 * its generated identity label. Values referencing resource attributes
 * (the quota's `teamName`, an instance group from the HyperPod cluster)
 * stay connected through the resource graph.
 */
export const hyperpod = (
  props: HyperPodWorkloadProps,
): {
  namespace?: Input<string>;
  labels?: Record<string, Input<string>>;
  podTemplate?: Record<string, unknown>;
} => {
  const teamName = props.quota?.teamName;
  const namespace =
    teamName !== undefined ? affix("hyperpod-ns-", teamName, "") : undefined;

  const labels: Record<string, Input<string>> = {
    ...(teamName !== undefined
      ? {
          [KUEUE_QUEUE_NAME_LABEL]: affix(
            "hyperpod-ns-",
            teamName,
            "-localqueue",
          ),
        }
      : {}),
    ...(props.priorityClass !== undefined
      ? {
          [KUEUE_PRIORITY_CLASS_LABEL]: affix(
            "",
            props.priorityClass,
            "-priority",
          ),
        }
      : {}),
  };

  const group = instanceGroupName(props.instanceGroup);
  const nodeSelector: Record<string, Input<string>> = {
    ...(props.healthyNodesOnly !== false
      ? { [HYPERPOD_NODE_HEALTH_LABEL]: "Schedulable" }
      : {}),
    ...(group !== undefined ? { [HYPERPOD_INSTANCE_GROUP_LABEL]: group } : {}),
  };

  return {
    ...(namespace !== undefined ? { namespace } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(Object.keys(nodeSelector).length > 0
      ? { podTemplate: { spec: { nodeSelector } } }
      : {}),
  };
};
