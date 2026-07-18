/**
 * 1:1 TypeScript mirrors of the Kubernetes API object model (core/v1, apps/v1,
 * batch/v1). These are plain types — no runtime behavior, no resource
 * providers. They exist so Kubernetes-shaped props elsewhere in alchemy
 * (`AWS.EKS.Manifest.manifest`, `AWS.EKS.Deployment.podTemplate`) are typed,
 * and so the zero-runtime builders in `./builders.ts` give completions.
 *
 * The distilled Kubernetes SDK (`distilled/packages/kubernetes`) generates
 * per-operation request/response interfaces rather than standalone model
 * types, so the model types are hand-bridged here, field-for-field with the
 * upstream OpenAPI spec. Fields not modeled yet can always be expressed
 * through an untyped `CustomManifest` (arbitrary CRDs are first-class).
 */

// ─────────────────────────────────────────────────────────────── meta/v1 ──

export interface ObjectMeta {
  /** Object name. Required for server-side apply. */
  name?: string;
  /** Prefix used by the server to generate a unique name. */
  generateName?: string;
  /** Namespace the object belongs to (namespaced kinds only). */
  namespace?: string;
  /** Map of string keys and values used to organize and categorize objects. */
  labels?: Record<string, string>;
  /** Unstructured key-value metadata. */
  annotations?: Record<string, string>;
  /** List of objects depended by this object. */
  ownerReferences?: OwnerReference[];
  /** Registered finalizers gating deletion. */
  finalizers?: string[];
  /** Server-populated unique id. */
  uid?: string;
  /** Server-populated resource version for optimistic concurrency. */
  resourceVersion?: string;
  /** Server-populated generation sequence number. */
  generation?: number;
  /** Server-populated creation timestamp. */
  creationTimestamp?: string;
  /** Server-populated deletion timestamp. */
  deletionTimestamp?: string;
}

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: LabelSelectorRequirement[];
}

export interface LabelSelectorRequirement {
  key: string;
  operator: "In" | "NotIn" | "Exists" | "DoesNotExist";
  values?: string[];
}

// ─────────────────────────────────────────────────────── core/v1 (pods) ──

export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: EnvVarSource;
}

export interface EnvVarSource {
  configMapKeyRef?: { name: string; key: string; optional?: boolean };
  secretKeyRef?: { name: string; key: string; optional?: boolean };
  fieldRef?: { apiVersion?: string; fieldPath: string };
  resourceFieldRef?: {
    containerName?: string;
    resource: string;
    divisor?: string;
  };
}

export interface EnvFromSource {
  prefix?: string;
  configMapRef?: { name: string; optional?: boolean };
  secretRef?: { name: string; optional?: boolean };
}

export interface ContainerPort {
  containerPort: number;
  name?: string;
  protocol?: "TCP" | "UDP" | "SCTP";
  hostPort?: number;
  hostIP?: string;
}

export interface VolumeMount {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
  mountPropagation?: string;
  subPathExpr?: string;
}

export interface ResourceRequirements {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
  claims?: { name: string; request?: string }[];
}

export interface HTTPGetAction {
  path?: string;
  port: number | string;
  host?: string;
  scheme?: "HTTP" | "HTTPS";
  httpHeaders?: { name: string; value: string }[];
}

export interface Probe {
  httpGet?: HTTPGetAction;
  tcpSocket?: { port: number | string; host?: string };
  exec?: { command?: string[] };
  grpc?: { port: number; service?: string };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
  terminationGracePeriodSeconds?: number;
}

export interface Lifecycle {
  postStart?: LifecycleHandler;
  preStop?: LifecycleHandler;
}

export interface LifecycleHandler {
  exec?: { command?: string[] };
  httpGet?: HTTPGetAction;
  tcpSocket?: { port: number | string; host?: string };
  sleep?: { seconds: number };
}

export interface SecurityContext {
  runAsUser?: number;
  runAsGroup?: number;
  runAsNonRoot?: boolean;
  readOnlyRootFilesystem?: boolean;
  allowPrivilegeEscalation?: boolean;
  privileged?: boolean;
  capabilities?: { add?: string[]; drop?: string[] };
  seccompProfile?: { type: string; localhostProfile?: string };
}

export interface Container {
  name: string;
  image?: string;
  command?: string[];
  args?: string[];
  workingDir?: string;
  env?: EnvVar[];
  envFrom?: EnvFromSource[];
  ports?: ContainerPort[];
  resources?: ResourceRequirements;
  volumeMounts?: VolumeMount[];
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
  lifecycle?: Lifecycle;
  securityContext?: SecurityContext;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  terminationMessagePath?: string;
  terminationMessagePolicy?: "File" | "FallbackToLogsOnError";
  stdin?: boolean;
  tty?: boolean;
}

export interface Toleration {
  key?: string;
  operator?: "Exists" | "Equal";
  value?: string;
  effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  tolerationSeconds?: number;
}

export interface NodeSelectorRequirement {
  key: string;
  operator: "In" | "NotIn" | "Exists" | "DoesNotExist" | "Gt" | "Lt";
  values?: string[];
}

export interface NodeSelectorTerm {
  matchExpressions?: NodeSelectorRequirement[];
  matchFields?: NodeSelectorRequirement[];
}

export interface Affinity {
  nodeAffinity?: {
    requiredDuringSchedulingIgnoredDuringExecution?: {
      nodeSelectorTerms: NodeSelectorTerm[];
    };
    preferredDuringSchedulingIgnoredDuringExecution?: {
      weight: number;
      preference: NodeSelectorTerm;
    }[];
  };
  podAffinity?: PodAffinity;
  podAntiAffinity?: PodAffinity;
}

export interface PodAffinityTerm {
  labelSelector?: LabelSelector;
  namespaceSelector?: LabelSelector;
  namespaces?: string[];
  topologyKey: string;
  matchLabelKeys?: string[];
  mismatchLabelKeys?: string[];
}

export interface PodAffinity {
  requiredDuringSchedulingIgnoredDuringExecution?: PodAffinityTerm[];
  preferredDuringSchedulingIgnoredDuringExecution?: {
    weight: number;
    podAffinityTerm: PodAffinityTerm;
  }[];
}

export interface TopologySpreadConstraint {
  maxSkew: number;
  topologyKey: string;
  whenUnsatisfiable: "DoNotSchedule" | "ScheduleAnyway";
  labelSelector?: LabelSelector;
  minDomains?: number;
  matchLabelKeys?: string[];
  nodeAffinityPolicy?: "Honor" | "Ignore";
  nodeTaintsPolicy?: "Honor" | "Ignore";
}

export interface Volume {
  name: string;
  emptyDir?: { medium?: string; sizeLimit?: string };
  configMap?: {
    name: string;
    items?: { key: string; path: string; mode?: number }[];
    defaultMode?: number;
    optional?: boolean;
  };
  secret?: {
    secretName: string;
    items?: { key: string; path: string; mode?: number }[];
    defaultMode?: number;
    optional?: boolean;
  };
  hostPath?: { path: string; type?: string };
  persistentVolumeClaim?: { claimName: string; readOnly?: boolean };
  projected?: { sources?: Record<string, unknown>[]; defaultMode?: number };
  downwardAPI?: {
    items?: {
      path: string;
      fieldRef?: { apiVersion?: string; fieldPath: string };
      mode?: number;
    }[];
  };
  csi?: {
    driver: string;
    readOnly?: boolean;
    fsType?: string;
    volumeAttributes?: Record<string, string>;
  };
  ephemeral?: { volumeClaimTemplate?: Record<string, unknown> };
}

export interface PodSecurityContext {
  runAsUser?: number;
  runAsGroup?: number;
  runAsNonRoot?: boolean;
  fsGroup?: number;
  fsGroupChangePolicy?: "OnRootMismatch" | "Always";
  supplementalGroups?: number[];
  seccompProfile?: { type: string; localhostProfile?: string };
  sysctls?: { name: string; value: string }[];
}

export interface LocalObjectReference {
  name: string;
}

export interface PodSpec {
  containers: Container[];
  initContainers?: Container[];
  ephemeralContainers?: (Container & { targetContainerName?: string })[];
  volumes?: Volume[];
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  restartPolicy?: "Always" | "OnFailure" | "Never";
  terminationGracePeriodSeconds?: number;
  activeDeadlineSeconds?: number;
  dnsPolicy?: "ClusterFirst" | "ClusterFirstWithHostNet" | "Default" | "None";
  dnsConfig?: {
    nameservers?: string[];
    searches?: string[];
    options?: { name: string; value?: string }[];
  };
  nodeSelector?: Record<string, string>;
  nodeName?: string;
  affinity?: Affinity;
  tolerations?: Toleration[];
  topologySpreadConstraints?: TopologySpreadConstraint[];
  schedulerName?: string;
  priorityClassName?: string;
  priority?: number;
  preemptionPolicy?: "PreemptLowerPriority" | "Never";
  runtimeClassName?: string;
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  shareProcessNamespace?: boolean;
  hostname?: string;
  subdomain?: string;
  setHostnameAsFQDN?: boolean;
  hostAliases?: { ip: string; hostnames?: string[] }[];
  imagePullSecrets?: LocalObjectReference[];
  securityContext?: PodSecurityContext;
  enableServiceLinks?: boolean;
  overhead?: Record<string, string>;
  os?: { name: "linux" | "windows" };
}

export interface PodTemplateSpec {
  metadata?: ObjectMeta;
  spec?: PodSpec;
}

export interface Pod {
  apiVersion: "v1";
  kind: "Pod";
  metadata: ObjectMeta;
  spec?: PodSpec;
}

// ─────────────────────────────────────────────────────────────── apps/v1 ──

export interface DeploymentStrategy {
  type?: "Recreate" | "RollingUpdate";
  rollingUpdate?: {
    maxUnavailable?: number | string;
    maxSurge?: number | string;
  };
}

export interface DeploymentSpec {
  replicas?: number;
  selector: LabelSelector;
  template: PodTemplateSpec;
  strategy?: DeploymentStrategy;
  minReadySeconds?: number;
  revisionHistoryLimit?: number;
  progressDeadlineSeconds?: number;
  paused?: boolean;
}

export interface Deployment {
  apiVersion: "apps/v1";
  kind: "Deployment";
  metadata: ObjectMeta;
  spec?: DeploymentSpec;
}

export interface StatefulSetSpec {
  serviceName?: string;
  replicas?: number;
  selector: LabelSelector;
  template: PodTemplateSpec;
  volumeClaimTemplates?: {
    metadata?: ObjectMeta;
    spec?: {
      accessModes?: string[];
      storageClassName?: string;
      resources?: { requests?: Record<string, string> };
      volumeMode?: "Filesystem" | "Block";
    };
  }[];
  updateStrategy?: {
    type?: "RollingUpdate" | "OnDelete";
    rollingUpdate?: { partition?: number; maxUnavailable?: number | string };
  };
  podManagementPolicy?: "OrderedReady" | "Parallel";
  minReadySeconds?: number;
  revisionHistoryLimit?: number;
  persistentVolumeClaimRetentionPolicy?: {
    whenDeleted?: "Retain" | "Delete";
    whenScaled?: "Retain" | "Delete";
  };
}

export interface StatefulSet {
  apiVersion: "apps/v1";
  kind: "StatefulSet";
  metadata: ObjectMeta;
  spec?: StatefulSetSpec;
}

export interface DaemonSetSpec {
  selector: LabelSelector;
  template: PodTemplateSpec;
  updateStrategy?: {
    type?: "RollingUpdate" | "OnDelete";
    rollingUpdate?: {
      maxUnavailable?: number | string;
      maxSurge?: number | string;
    };
  };
  minReadySeconds?: number;
  revisionHistoryLimit?: number;
}

export interface DaemonSet {
  apiVersion: "apps/v1";
  kind: "DaemonSet";
  metadata: ObjectMeta;
  spec?: DaemonSetSpec;
}

// ────────────────────────────────────────────────────────────── batch/v1 ──

export interface JobSpec {
  template: PodTemplateSpec;
  parallelism?: number;
  completions?: number;
  completionMode?: "NonIndexed" | "Indexed";
  backoffLimit?: number;
  backoffLimitPerIndex?: number;
  maxFailedIndexes?: number;
  activeDeadlineSeconds?: number;
  ttlSecondsAfterFinished?: number;
  suspend?: boolean;
  selector?: LabelSelector;
  manualSelector?: boolean;
  podFailurePolicy?: Record<string, unknown>;
  podReplacementPolicy?: "TerminatingOrFailed" | "Failed";
}

export interface Job {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: ObjectMeta;
  spec?: JobSpec;
}

export interface JobTemplateSpec {
  metadata?: ObjectMeta;
  spec?: JobSpec;
}

export interface CronJobSpec {
  schedule: string;
  timeZone?: string;
  jobTemplate: JobTemplateSpec;
  concurrencyPolicy?: "Allow" | "Forbid" | "Replace";
  startingDeadlineSeconds?: number;
  suspend?: boolean;
  successfulJobsHistoryLimit?: number;
  failedJobsHistoryLimit?: number;
}

export interface CronJob {
  apiVersion: "batch/v1";
  kind: "CronJob";
  metadata: ObjectMeta;
  spec?: CronJobSpec;
}

// ─────────────────────────────────────────────────── core/v1 (services) ──

export interface ServicePort {
  port: number;
  targetPort?: number | string;
  protocol?: "TCP" | "UDP" | "SCTP";
  name?: string;
  nodePort?: number;
  appProtocol?: string;
}

export interface ServiceSpec {
  type?: "ClusterIP" | "NodePort" | "LoadBalancer" | "ExternalName";
  selector?: Record<string, string>;
  ports?: ServicePort[];
  clusterIP?: string;
  externalName?: string;
  externalTrafficPolicy?: "Cluster" | "Local";
  internalTrafficPolicy?: "Cluster" | "Local";
  sessionAffinity?: "ClientIP" | "None";
  loadBalancerClass?: string;
  loadBalancerSourceRanges?: string[];
  allocateLoadBalancerNodePorts?: boolean;
  ipFamilies?: ("IPv4" | "IPv6")[];
  ipFamilyPolicy?: "SingleStack" | "PreferDualStack" | "RequireDualStack";
  publishNotReadyAddresses?: boolean;
}

export interface Service {
  apiVersion: "v1";
  kind: "Service";
  metadata: ObjectMeta;
  spec?: ServiceSpec;
}

// ──────────────────────────────────────────────────── core/v1 (config) ──

export interface ConfigMap {
  apiVersion: "v1";
  kind: "ConfigMap";
  metadata: ObjectMeta;
  data?: Record<string, string>;
  binaryData?: Record<string, string>;
  immutable?: boolean;
}

export interface Secret {
  apiVersion: "v1";
  kind: "Secret";
  metadata: ObjectMeta;
  type?: string;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  immutable?: boolean;
}

export interface Namespace {
  apiVersion: "v1";
  kind: "Namespace";
  metadata: ObjectMeta;
  spec?: { finalizers?: string[] };
}

export interface ServiceAccount {
  apiVersion: "v1";
  kind: "ServiceAccount";
  metadata: ObjectMeta;
  automountServiceAccountToken?: boolean;
  imagePullSecrets?: LocalObjectReference[];
  secrets?: { name?: string; namespace?: string; kind?: string }[];
}

// ───────────────────────────────────────────────────────────── manifest ──

/**
 * An arbitrary (untyped) Kubernetes object — the escape hatch for CRDs and
 * kinds not modeled above. `apiVersion`, `kind`, and `metadata` are the only
 * structural requirements; everything else is free-form.
 */
export interface CustomManifest {
  apiVersion: string;
  kind: string;
  metadata: ObjectMeta;
  [key: string]: unknown;
}

/**
 * Any Kubernetes object accepted by `AWS.EKS.Manifest`: one of the typed
 * kinds above, or an untyped `CustomManifest` (arbitrary CRDs allowed).
 */
export type Manifest =
  | Pod
  | Deployment
  | StatefulSet
  | DaemonSet
  | Job
  | CronJob
  | Service
  | ConfigMap
  | Secret
  | Namespace
  | ServiceAccount
  | CustomManifest;

/**
 * Deeply-optional variant of a Kubernetes type. Used by escape hatches like
 * `AWS.EKS.Deployment.podTemplate`, where a partial template is deep-merged
 * into a synthesized one (objects merge recursively; arrays and primitives
 * from the partial replace the synthesized value wholesale).
 */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
