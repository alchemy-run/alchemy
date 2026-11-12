import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, createTagsList, diffTags, hasTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { retryWhileLingeringEnis } from "../EC2/LingeringEnis.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type CapacityProviderName = string;
export type CapacityProviderArn =
  `arn:aws:ecs:${RegionID}:${AccountID}:capacity-provider/${CapacityProviderName}`;

/**
 * How ECS launches each instance of a Managed Instances capacity provider.
 */
export interface ManagedInstancesLaunchTemplate extends Omit<
  ecs.InstanceLaunchTemplate,
  "ec2InstanceProfileArn"
> {
  /**
   * ARN of the instance profile the instances run with. Its role needs the
   * `AmazonECSInstanceRolePolicyForManagedInstances` managed policy and a
   * trust policy for `ec2.amazonaws.com`.
   *
   * If omitted, the capacity provider creates the role and the profile, and
   * deletes them with itself.
   */
  ec2InstanceProfileArn?: string;
}

/**
 * Configuration of an Amazon ECS Managed Instances capacity provider: ECS
 * launches, patches and scales the EC2 instances itself.
 */
export interface ManagedInstancesProviderProps {
  /**
   * ARN of the infrastructure IAM role ECS assumes to launch and manage the
   * instances. It needs the
   * `AmazonECSInfrastructureRolePolicyForManagedInstances` managed policy, a
   * trust policy for `ecs.amazonaws.com`, and `iam:PassRole` on the instance
   * role.
   *
   * If omitted, the capacity provider creates the role and deletes it with
   * itself.
   */
  infrastructureRoleArn?: string;
  /**
   * How ECS launches each instance: instance profile, subnets, instance
   * requirements, and whether the instances run Nitro Sandboxes
   * (`nitroEnclavesEnabled`).
   *
   * With `nitroEnclavesEnabled` and no `instanceRequirements`, the instances
   * are 4 to 16 vCPU `m6i`, `m7i`, `c6i`, `c7i`, `r6i` and `r7i` types, which
   * support Nitro Sandboxes.
   *
   * ECS requires a security group for the instances. If
   * `networkConfiguration.securityGroups` is omitted, the capacity provider
   * creates one in the subnets' VPC that allows outbound traffic only, and
   * deletes it with itself.
   *
   * `capacityOptionType`, `fipsEnabled` and `nitroEnclavesEnabled` can't be
   * changed after creation; changing one replaces the capacity provider.
   */
  instanceLaunchTemplate: ManagedInstancesLaunchTemplate;
  /**
   * Whether ECS copies the capacity provider's tags onto the instances it
   * launches.
   * @default "NONE"
   */
  propagateTags?: ecs.PropagateMITags;
  /**
   * How long ECS waits before it consolidates under-used instances.
   */
  infrastructureOptimization?: ecs.InfrastructureOptimization;
  /**
   * Whether ECS replaces instances it finds unhealthy.
   */
  autoRepairConfiguration?: ecs.AutoRepairConfiguration;
}

export interface CapacityProviderProps {
  /**
   * Capacity provider name. If omitted, a deterministic name is generated;
   * a generated name that would begin with a reserved prefix gets `cp-`
   * prepended.
   *
   * Names beginning with `aws`, `ecs`, or `fargate` are reserved by AWS.
   * Changing this triggers a replacement.
   */
  name?: string;
  /**
   * Name of the cluster a Managed Instances capacity provider belongs to.
   * Managed Instances capacity providers are scoped to one cluster and are
   * available to that cluster's services and tasks without being listed in
   * {@link Cluster#capacityProviders}.
   *
   * Required with {@link managedInstancesProvider}. Changing this triggers a
   * replacement.
   */
  cluster?: string;
  /**
   * ARN of the EC2 Auto Scaling Group that backs this capacity provider.
   * Set exactly one of `autoScalingGroupArn` and
   * {@link managedInstancesProvider}.
   *
   * Cannot be changed after creation; changing this triggers a replacement.
   */
  autoScalingGroupArn?: string;
  /**
   * Managed scaling configuration applied by ECS to the underlying ASG.
   */
  managedScaling?: ecs.ManagedScaling;
  /**
   * Whether ECS protects in-use container instances from ASG scale-in.
   * @default "DISABLED"
   */
  managedTerminationProtection?: ecs.ManagedTerminationProtection;
  /**
   * Whether ECS sets container instances to DRAINING when terminated by ASG.
   * @default "DISABLED"
   */
  managedDraining?: ecs.ManagedDraining;
  /**
   * Make this an Amazon ECS Managed Instances capacity provider. Set exactly
   * one of `managedInstancesProvider` and {@link autoScalingGroupArn}.
   */
  managedInstancesProvider?: ManagedInstancesProviderProps;
  /**
   * User-defined tags to apply to the capacity provider.
   */
  tags?: Record<string, string>;
}

export interface CapacityProvider extends Resource<
  "AWS.ECS.CapacityProvider",
  CapacityProviderProps,
  {
    /** The ARN of the capacity provider. */
    capacityProviderArn: CapacityProviderArn;
    /** The name of the capacity provider. */
    name: CapacityProviderName;
    /** The kind of capacity provider: `EC2_AUTOSCALING` or `MANAGED_INSTANCES`. */
    type: ecs.CapacityProviderType | undefined;
    /** The cluster a Managed Instances capacity provider belongs to. */
    cluster: string | undefined;
    /** The current status, e.g. `ACTIVE`. */
    status: ecs.CapacityProviderStatus;
    /** The status of the most recent update to the provider. */
    updateStatus: ecs.CapacityProviderUpdateStatus | undefined;
    /** The Auto Scaling group backing the provider (`""` for Managed Instances). */
    autoScalingGroupArn: string;
    /** The managed scaling configuration. */
    managedScaling: ecs.ManagedScaling | undefined;
    /** Whether managed termination protection is enabled. */
    managedTerminationProtection: ecs.ManagedTerminationProtection | undefined;
    /** Whether managed instance draining is enabled. */
    managedDraining: ecs.ManagedDraining | undefined;
    /** The Managed Instances configuration, for a Managed Instances provider. */
    managedInstancesProvider: ecs.ManagedInstancesProvider | undefined;
    /** The subnets a Managed Instances provider launches instances into (`[]` otherwise). */
    subnets: string[];
    /** The VPC of those subnets. */
    vpcId: string | undefined;
    /** The infrastructure role the provider created, when `infrastructureRoleArn` was omitted. */
    infrastructureRoleName: string | undefined;
    /** The instance role the provider created, when `ec2InstanceProfileArn` was omitted. */
    instanceRoleName: string | undefined;
    /** The instance profile the provider created, when `ec2InstanceProfileArn` was omitted. */
    instanceProfileName: string | undefined;
    /** The security group the provider created for its instances, when the launch template named none. */
    securityGroupId: string | undefined;
    /**
     * A security group with no inbound rules for the tasks that run on a
     * Managed Instances provider's instances. `AWS.ECS.CreateSandbox` gives
     * it to its sandboxes.
     */
    taskSecurityGroupId: string | undefined;
    /** The tags attached to the capacity provider. */
    tags: Record<string, string>;
  },
  never,
  Providers,
  CapacityProviderLookup
> {}

/**
 * Props for {@link CapacityProvider.lookup}: find a capacity provider this stack doesn't
 * manage, in the ambient account and region.
 */
export interface CapacityProviderLookup {
  /** The name of the existing capacity provider. */
  name: string;
  /** The cluster of an existing Managed Instances capacity provider. */
  cluster?: string;
}

/**
 * An Amazon ECS capacity provider, backed by an EC2 Auto Scaling Group or by
 * Amazon ECS Managed Instances.
 *
 * Auto Scaling Group providers are associated with one or more ECS clusters
 * via {@link Cluster#capacityProviders}. Managed Instances providers belong
 * to one `cluster` and are available to it as soon as they exist. Services
 * and tasks select either kind through a capacity provider strategy.
 *
 * The reserved AWS providers `FARGATE` and `FARGATE_SPOT` do not need to be
 * created and can be referenced by name on a `Cluster` directly.
 * ### Creating Capacity Providers
 * **Example:** ASG-Backed Capacity Provider
 * ```typescript
 * const provider = yield* CapacityProvider("AppCapacityProvider", {
 *   autoScalingGroupArn: asg.autoScalingGroupArn,
 *   managedScaling: {
 *     status: "ENABLED",
 *     targetCapacity: 80,
 *     minimumScalingStepSize: 1,
 *     maximumScalingStepSize: 10,
 *   },
 *   managedTerminationProtection: "ENABLED",
 * });
 *
 * yield* Cluster("AppCluster", {
 *   capacityProviders: [provider.name],
 *   defaultCapacityProviderStrategy: [
 *     { capacityProvider: provider.name, weight: 1 },
 *   ],
 * });
 * ```
 *
 * ### Managed Instances
 * ECS launches and patches the instances of a Managed Instances provider
 * itself, when tasks need them, and drains them when they are empty. The
 * provider creates the infrastructure role ECS assumes, the instance profile
 * the instances run with and their security group, unless you pass your own.
 *
 * It also creates a security group for the tasks that run on the instances,
 * `taskSecurityGroupId`, with no inbound rules. Deleting the provider stops
 * the tasks still running on it, then deletes both groups.
 *
 * **Example:** Managed Instances Capacity Provider
 * ```typescript
 * const cluster = yield* Cluster("AppCluster", {});
 *
 * const provider = yield* CapacityProvider("AppInstances", {
 *   cluster: cluster.clusterName,
 *   managedInstancesProvider: {
 *     instanceLaunchTemplate: {
 *       networkConfiguration: { subnets: [subnet.subnetId] },
 *       instanceRequirements: {
 *         vCpuCount: { min: 2, max: 8 },
 *         memoryMiB: { min: 4096 },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Your own infrastructure role and instance profile
 * ```typescript
 * const provider = yield* CapacityProvider("AppInstances", {
 *   cluster: cluster.clusterName,
 *   managedInstancesProvider: {
 *     infrastructureRoleArn: infrastructureRole.roleArn,
 *     instanceLaunchTemplate: {
 *       ec2InstanceProfileArn: instanceProfile.instanceProfileArn,
 *       networkConfiguration: { subnets: [subnet.subnetId] },
 *       instanceRequirements: {
 *         vCpuCount: { min: 2, max: 8 },
 *         memoryMiB: { min: 4096 },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### Nitro Sandboxes
 * Set `nitroEnclavesEnabled` to launch instances that run each task in its
 * own [Nitro Sandbox](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/isolated-confidential-tasks.html),
 * a lightweight VM isolated by the Nitro hypervisor. The provider picks
 * instance types that support Nitro Sandboxes. Tasks opt in with
 * `isolation: "isolated"` on `AWS.ECS.Task`.
 *
 * **Example:** Capacity for isolated tasks
 * ```typescript
 * const provider = yield* CapacityProvider("SandboxInstances", {
 *   cluster: cluster.clusterName,
 *   managedInstancesProvider: {
 *     instanceLaunchTemplate: {
 *       networkConfiguration: { subnets: network.privateSubnetIds },
 *       nitroEnclavesEnabled: true,
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Choose the instance types
 * ```typescript
 * const provider = yield* CapacityProvider("SandboxInstances", {
 *   cluster: cluster.clusterName,
 *   managedInstancesProvider: {
 *     instanceLaunchTemplate: {
 *       networkConfiguration: { subnets: network.privateSubnetIds },
 *       nitroEnclavesEnabled: true,
 *       instanceRequirements: {
 *         vCpuCount: { min: 4, max: 8 },
 *         memoryMiB: { min: 8192 },
 *         allowedInstanceTypes: ["m6i.xlarge", "m7i.xlarge"],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### Adopting Existing Capacity Providers
 * Foreign-tagged capacity providers (i.e. providers that exist in AWS but were
 * not created by this stack/stage/logical-id) are surfaced as `Unowned` by
 * `read`, and the engine fails with `OwnedBySomeoneElse` unless adoption is
 * explicitly opted in via `--adopt` or {@link adopt}.
 * **Example:** Adopt an existing provider
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * yield* CapacityProvider("AppCapacityProvider", {
 *   name: "existing-provider",
 *   autoScalingGroupArn: asg.autoScalingGroupArn,
 * }).pipe(adopt());
 * ```
 *
 * ### Looking up an existing capacity provider
 * `CapacityProvider.lookup` references a capacity provider Alchemy doesn't manage (created in the
 * console or by another stack), found by `name` (and `cluster`, for a
 * Managed Instances provider). It is read during plan/deploy and never
 * created, updated or deleted.
 *
 * **Example:** Reference an existing capacity provider
 * ```typescript
 * const spot = AWS.ECS.CapacityProvider.lookup({ name: "spot" });
 * ```
 *
 * @resource
 */
export const CapacityProvider = Resource<CapacityProvider>("AWS.ECS.CapacityProvider");

class CapacityProviderNotSettled extends Data.TaggedError("CapacityProviderNotSettled")<{
  readonly message: string;
  readonly capacityProvider: string;
  readonly status: string | undefined;
  readonly updateStatus: string | undefined;
}> {}

class CapacityProviderTasksNotStopped extends Data.TaggedError("CapacityProviderTasksNotStopped")<{
  readonly message: string;
  readonly capacityProvider: string;
  readonly tasks: string[];
}> {}

class CapacityProviderConflict extends Data.TaggedError("CapacityProviderConflict")<{
  readonly message: string;
}> {}

/** Launch template fields `updateCapacityProvider` can't change. */
const immutableLaunchTemplate = (template: ManagedInstancesLaunchTemplate | undefined) => ({
  capacityOptionType: template?.capacityOptionType,
  fipsEnabled: template?.fipsEnabled ?? false,
  nitroEnclavesEnabled: template?.nitroEnclavesEnabled ?? false,
});

const INSTANCE_ROLE_POLICY =
  "arn:aws:iam::aws:policy/AmazonECSInstanceRolePolicyForManagedInstances";
const INFRASTRUCTURE_ROLE_POLICY =
  "arn:aws:iam::aws:policy/AmazonECSInfrastructureRolePolicyForManagedInstances";

/**
 * Instance types for Nitro Sandboxes when the launch template names none.
 * Sandboxes need a type with Nitro Enclaves support, which leaves out the
 * burstable families and the smallest sizes. Task images build for x86-64
 * unless a task asks for ARM, so these are Intel types.
 */
const sandboxInstanceRequirements: ecs.InstanceRequirementsRequest = {
  vCpuCount: { min: 4, max: 16 },
  memoryMiB: { min: 8192 },
  allowedInstanceTypes: ["m6i", "m7i", "c6i", "c7i", "r6i", "r7i"].flatMap((family) =>
    ["xlarge", "2xlarge", "4xlarge"].map((size) => `${family}.${size}`),
  ),
};

const assumeRolePolicy = (service: string) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }],
  });

/** Creates the role, or takes one this capacity provider already owns. */
const ensureRole = Effect.fn(function* (
  roleName: string,
  service: string,
  tags: Record<string, string>,
) {
  const role = yield* iam
    .createRole({
      RoleName: roleName,
      AssumeRolePolicyDocument: assumeRolePolicy(service),
      Tags: createTagsList(tags),
    })
    .pipe(
      Effect.catchTag("EntityAlreadyExistsException", () =>
        iam.getRole({ RoleName: roleName }).pipe(
          Effect.filterOrFail(
            (existing) => hasTags(tags, existing.Role?.Tags),
            () =>
              new CapacityProviderConflict({
                message: `Role '${roleName}' already exists and is not managed by alchemy`,
              }),
          ),
        ),
      ),
    );
  return role.Role.Arn;
});

/** Creates the instance profile, or takes an owned one, and puts the role in it. */
const ensureInstanceProfile = Effect.fn(function* (
  profileName: string,
  roleName: string,
  tags: Record<string, string>,
) {
  const observed = yield* iam
    .getInstanceProfile({ InstanceProfileName: profileName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.undefined));
  const profile =
    observed?.InstanceProfile ??
    (yield* iam
      .createInstanceProfile({ InstanceProfileName: profileName, Tags: createTagsList(tags) })
      .pipe(
        Effect.catchTag("EntityAlreadyExistsException", () =>
          iam.getInstanceProfile({ InstanceProfileName: profileName }),
        ),
      )).InstanceProfile;
  if (!hasTags(tags, profile.Tags)) {
    return yield* new CapacityProviderConflict({
      message: `Instance profile '${profileName}' already exists and is not managed by alchemy`,
    });
  }
  const attached = profile.Roles.map((role) => role.RoleName);
  for (const other of attached.filter((name) => name !== roleName)) {
    yield* iam
      .removeRoleFromInstanceProfile({ InstanceProfileName: profileName, RoleName: other })
      .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
  }
  if (!attached.includes(roleName)) {
    yield* iam
      .addRoleToInstanceProfile({ InstanceProfileName: profileName, RoleName: roleName })
      .pipe(
        // The role was just created and the profile can't see it yet.
        Effect.retry({
          while: (e) => e._tag === "NoSuchEntityException",
          schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(8)]),
        }),
        // Another reconcile of this provider attached it first.
        Effect.catchTag("LimitExceededException", () => Effect.void),
      );
  }
  return profile.Arn;
});

const deleteOwnedInstanceProfile = Effect.fn(function* (profileName: string) {
  const observed = yield* iam
    .getInstanceProfile({ InstanceProfileName: profileName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.undefined));
  if (observed === undefined) return;
  for (const role of observed.InstanceProfile.Roles) {
    yield* iam
      .removeRoleFromInstanceProfile({
        InstanceProfileName: profileName,
        RoleName: role.RoleName,
      })
      .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
  }
  yield* iam
    .deleteInstanceProfile({ InstanceProfileName: profileName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
});

const deleteOwnedRole = Effect.fn(function* (roleName: string) {
  yield* iam.listRolePolicies.items({ RoleName: roleName }).pipe(
    Stream.mapEffect((policyName) =>
      iam
        .deleteRolePolicy({ RoleName: roleName, PolicyName: policyName })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
    ),
    Stream.runDrain,
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
  );
  yield* iam.listAttachedRolePolicies.items({ RoleName: roleName }).pipe(
    Stream.mapEffect((policy) =>
      iam
        .detachRolePolicy({ RoleName: roleName, PolicyArn: policy.PolicyArn! })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
    ),
    Stream.runDrain,
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
  );
  yield* iam
    .deleteRole({ RoleName: roleName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
});

/** The VPC of a launch template's subnets. */
const vpcOf = Effect.fn(function* (subnets: readonly string[]) {
  const [subnet] = subnets;
  if (subnet === undefined) return undefined;
  const found = yield* ec2
    .describeSubnets({ SubnetIds: [subnet] })
    .pipe(Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.undefined));
  return found?.Subnets?.[0]?.VpcId;
});

/** A security group the provider owns, when it exists. */
const findSecurityGroup = Effect.fn(function* (
  groupName: string,
  vpcId: string,
  groupId: string | undefined,
) {
  const cached =
    groupId === undefined
      ? undefined
      : yield* ec2.describeSecurityGroups({ GroupIds: [groupId] }).pipe(
          Effect.map((found) => found.SecurityGroups?.[0]),
          Effect.catchTag("InvalidGroup.NotFound", () => Effect.undefined),
        );
  if (cached !== undefined) return cached;
  const named = yield* ec2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpcId] },
      { Name: "group-name", Values: [groupName] },
    ],
  });
  return named.SecurityGroups?.[0];
});

/**
 * Creates a security group for the provider, or takes one this capacity
 * provider already owns. The group keeps EC2's default rules, all outbound and
 * no inbound. Tasks on Managed Instances have their own network interface and
 * security groups, so nothing needs to reach the instances; whoever calls the
 * tasks adds a rule to their group.
 */
const ensureSecurityGroup = Effect.fn(function* (
  groupName: string,
  description: string,
  vpcId: string,
  tags: Record<string, string>,
  groupId: string | undefined,
) {
  const observed = yield* findSecurityGroup(groupName, vpcId, groupId);
  if (observed === undefined) {
    const created = yield* ec2
      .createSecurityGroup({
        GroupName: groupName,
        Description: description,
        VpcId: vpcId,
        TagSpecifications: [{ ResourceType: "security-group", Tags: createTagsList(tags) }],
      })
      .pipe(
        // The VPC was just created.
        Effect.retry({
          while: (e) => e._tag === "InvalidVpcID.NotFound",
          schedule: Schedule.fixed("1 second"),
          times: 8,
        }),
        // Another reconcile of this provider created it first.
        Effect.catchTag("InvalidGroup.Duplicate", () => Effect.undefined),
      );
    if (created?.GroupId !== undefined) return created.GroupId;
  }
  const group = observed ?? (yield* findSecurityGroup(groupName, vpcId, groupId));
  const groupTags = Object.fromEntries(
    (group?.Tags ?? []).flatMap((tag) =>
      tag.Key !== undefined && tag.Value !== undefined ? [[tag.Key, tag.Value] as const] : [],
    ),
  );
  if (group?.GroupId === undefined || !hasTags(tags, groupTags)) {
    return yield* new CapacityProviderConflict({
      message: `Security group '${groupName}' already exists in ${vpcId} and is not managed by alchemy`,
    });
  }
  return group.GroupId;
});

export const CapacityProviderProvider = () =>
  Provider.effect(
    CapacityProvider,
    Effect.gen(function* () {
      const toEcsTags = (tags: Record<string, string>): ecs.Tag[] =>
        Object.entries(tags).map(([key, value]) => ({ key, value }));

      const fromEcsTags = (tags: ecs.Tag[] | undefined): Record<string, string> =>
        Object.fromEntries(
          (tags ?? [])
            .filter(
              (t): t is { key: string; value: string } =>
                t.key !== undefined && t.value !== undefined,
            )
            .map((t) => [t.key, t.value]),
        );

      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 252, lowercase: true }).pipe(
              // AWS rejects generated names that start with a reserved prefix
              // (e.g. a stack named "AWS-...").
              Effect.map((name) => (/^(aws|ecs|fargate)/.test(name) ? `cp-${name}` : name)),
            );

      // `describeCapacityProviders` is a plain operation (no `.pages`), so
      // drive its `nextToken` pagination with `Stream.paginate`.
      const describeAll = (cluster: string | undefined) =>
        Stream.paginate(undefined as string | undefined, (token) =>
          ecs
            .describeCapacityProviders({
              cluster,
              include: ["TAGS"],
              ...(token ? { nextToken: token } : {}),
            })
            .pipe(
              Effect.map(
                (res) =>
                  [
                    res.capacityProviders ?? [],
                    res.nextToken ? Option.some(res.nextToken) : Option.none<string>(),
                  ] as const,
              ),
            ),
        );

      // Managed Instances providers are only returned when describing their
      // cluster, and ECS rejects a request naming both providers and a
      // cluster, so a cluster-scoped provider is found in its cluster's list.
      const describe = (name: string, cluster: string | undefined) =>
        (cluster
          ? describeAll(cluster).pipe(
              Stream.filter((p) => p.name === name && p.status !== "INACTIVE"),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
            )
          : ecs.describeCapacityProviders({ capacityProviders: [name], include: ["TAGS"] }).pipe(
              // A deleted provider stays describable as INACTIVE for a
              // while and can no longer be updated, so treat it as missing.
              Effect.map((res) =>
                res.capacityProviders?.find((p) => p.name === name && p.status !== "INACTIVE"),
              ),
            )
        ).pipe(
          // The cluster itself is gone, and its providers with it.
          Effect.catchTag("ClusterNotFoundException", () => Effect.undefined),
        );

      const subnetsOf = (found: ecs.CapacityProvider | undefined) =>
        found?.managedInstancesProvider?.instanceLaunchTemplate?.networkConfiguration?.subnets ??
        [];

      const attrsOf = (
        found: ecs.CapacityProvider & { name: string; capacityProviderArn: string },
        cluster: string | undefined,
        // What only this stack's state knows: the VPC it resolved, and the
        // IAM and the security groups it created for the provider.
        known?: Partial<
          Pick<
            CapacityProvider["Attributes"],
            | "vpcId"
            | "infrastructureRoleName"
            | "instanceRoleName"
            | "instanceProfileName"
            | "securityGroupId"
            | "taskSecurityGroupId"
          >
        >,
      ): CapacityProvider["Attributes"] => ({
        subnets: subnetsOf(found),
        vpcId: known?.vpcId,
        infrastructureRoleName: known?.infrastructureRoleName,
        instanceRoleName: known?.instanceRoleName,
        instanceProfileName: known?.instanceProfileName,
        securityGroupId: known?.securityGroupId,
        taskSecurityGroupId: known?.taskSecurityGroupId,
        capacityProviderArn: found.capacityProviderArn as CapacityProviderArn,
        name: found.name,
        type: found.type,
        cluster: found.cluster ?? cluster,
        status: (found.status ?? "ACTIVE") as ecs.CapacityProviderStatus,
        updateStatus: found.updateStatus,
        autoScalingGroupArn: found.autoScalingGroupProvider?.autoScalingGroupArn ?? "",
        managedScaling: found.autoScalingGroupProvider?.managedScaling,
        managedTerminationProtection: found.autoScalingGroupProvider?.managedTerminationProtection,
        managedDraining: found.autoScalingGroupProvider?.managedDraining,
        managedInstancesProvider: found.managedInstancesProvider,
        tags: fromEcsTags(found.tags),
      });

      // A just-created infrastructure role takes a few seconds to become
      // assumable by ECS.
      const retryRolePropagation = {
        while: (e: { _tag: string }) => e._tag === "InfrastructureRoleAccessDenied",
        schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(15)]),
      };

      // A Managed Instances provider is PROVISIONING after create and
      // DEPROVISIONING (terminating its instances) after delete. Services
      // can't use it until ACTIVE, and its cluster and infrastructure role
      // can't go until it is gone.
      const settle = Effect.fn(function* (
        name: string,
        cluster: string | undefined,
        done: (p: ecs.CapacityProvider | undefined) => boolean,
      ) {
        return yield* describe(name, cluster).pipe(
          Effect.flatMap((p) =>
            done(p)
              ? Effect.succeed(p)
              : Effect.fail(
                  new CapacityProviderNotSettled({
                    message: `Capacity provider ${name} is still ${p?.updateStatus ?? p?.status ?? "missing"}${p?.updateStatusReason ? `: ${p.updateStatusReason}` : ""}`,
                    capacityProvider: name,
                    status: p?.status,
                    updateStatus: p?.updateStatus,
                  }),
                ),
          ),
          Effect.retry({
            while: (e) => e._tag === "CapacityProviderNotSettled",
            schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(36)]),
          }),
        );
      });

      // The provider's tasks that have not stopped yet: the ones ECS still
      // wants running, and the ones on their way down.
      const liveTasks = Effect.fn(function* (name: string, cluster: string) {
        const taskArns = yield* Effect.forEach(
          ["RUNNING", "STOPPED"] as const,
          (desiredStatus) =>
            ecs.listTasks.pages({ cluster, desiredStatus }).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk).flatMap((page) => page.taskArns ?? [])),
            ),
          { concurrency: 2 },
        ).pipe(Effect.map((listed) => listed.flat()));
        const batches = Array.from({ length: Math.ceil(taskArns.length / 100) }, (_, index) =>
          taskArns.slice(index * 100, (index + 1) * 100),
        );
        const described = yield* Effect.forEach(batches, (tasks) =>
          ecs.describeTasks({ cluster, tasks }).pipe(Effect.map((res) => res.tasks ?? [])),
        );
        return described
          .flat()
          .filter(
            (task): task is ecs.Task & { taskArn: string } =>
              task.taskArn !== undefined &&
              task.capacityProviderName === name &&
              task.lastStatus !== "STOPPED",
          );
      });

      // Tasks started at run time (`RunTask`, sandboxes) are not in the
      // stack, and ECS refuses to delete a provider until every one of its
      // tasks has stopped. Stop them and wait: a task takes up to a minute
      // to go from stopping to stopped.
      const stopTasks = Effect.fn(function* (name: string, cluster: string) {
        const running = yield* liveTasks(name, cluster);
        yield* Effect.forEach(
          running.filter((task) => task.desiredStatus !== "STOPPED"),
          (task) =>
            ecs.stopTask({ cluster, task: task.taskArn, reason: "alchemy delete" }).pipe(
              // Stopped between the listing and now.
              Effect.catchTag("InvalidParameterException", () => Effect.void),
            ),
          { discard: true, concurrency: 8 },
        );
        if (running.length === 0) return;
        yield* liveTasks(name, cluster).pipe(
          Effect.flatMap((tasks) =>
            tasks.length === 0
              ? Effect.void
              : Effect.fail(
                  new CapacityProviderTasksNotStopped({
                    message: `${tasks.length} task(s) of capacity provider ${name} are still stopping`,
                    capacityProvider: name,
                    tasks: tasks.map((task) => task.taskArn),
                  }),
                ),
          ),
          Effect.retry({
            while: (e) => e._tag === "CapacityProviderTasksNotStopped",
            schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(60)]),
          }),
        );
      });

      // Ready to use, with any update applied (updates run asynchronously).
      const isReady = (p: ecs.CapacityProvider | undefined) =>
        p === undefined ||
        (p.status === "ACTIVE" &&
          p.updateStatus !== "UPDATE_IN_PROGRESS" &&
          p.updateStatus !== "CREATE_IN_PROGRESS");

      const hasIdentity = (
        p: ecs.CapacityProvider | undefined,
      ): p is ecs.CapacityProvider & { name: string; capacityProviderArn: string } =>
        p?.name != null && p.capacityProviderArn != null;

      return {
        stables: ["capacityProviderArn", "name", "type", "cluster"],

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (olds.cluster !== news.cluster) {
            return { action: "replace" } as const;
          }
          // Switching between an ASG and Managed Instances is a new provider.
          if (!!olds.managedInstancesProvider !== !!news.managedInstancesProvider) {
            return { action: "replace" } as const;
          }
          if (
            isResolved(olds.autoScalingGroupArn) &&
            olds.autoScalingGroupArn !== news.autoScalingGroupArn
          ) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(
              immutableLaunchTemplate(olds.managedInstancesProvider?.instanceLaunchTemplate),
              immutableLaunchTemplate(news.managedInstancesProvider?.instanceLaunchTemplate),
            )
          ) {
            return { action: "replace" } as const;
          }
        }),

        lookup: Effect.fn(function* ({ name, cluster }) {
          const found = yield* describe(name, cluster);
          return hasIdentity(found)
            ? attrsOf(found, cluster, { vpcId: yield* vpcOf(subnetsOf(found)) })
            : undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* toName(id, olds ?? {}));
          const cluster = output?.cluster ?? olds?.cluster;
          const found = yield* describe(name, cluster);
          if (!hasIdentity(found)) {
            return undefined;
          }
          const internalTags = yield* createInternalTags(id);
          const attrs = attrsOf(found, cluster, {
            vpcId: output?.vpcId ?? (yield* vpcOf(subnetsOf(found))),
            infrastructureRoleName: output?.infrastructureRoleName,
            instanceRoleName: output?.instanceRoleName,
            instanceProfileName: output?.instanceProfileName,
            securityGroupId: output?.securityGroupId,
            taskSecurityGroupId: output?.taskSecurityGroupId,
          });
          return hasTags(internalTags, attrs.tags) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          // The engine owns the name: keep the one already deployed.
          const name = output?.name ?? (yield* toName(id, news));
          const cluster = news.cluster;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const template = news.managedInstancesProvider?.instanceLaunchTemplate;

          // Ensure the IAM a Managed Instances provider runs with — the
          // instance profile, then the infrastructure role that passes it —
          // for whichever of the two the props leave out.
          const ownsInstanceProfile =
            template !== undefined && template.ec2InstanceProfileArn === undefined;
          const ownsInfrastructureRole =
            news.managedInstancesProvider !== undefined &&
            news.managedInstancesProvider.infrastructureRoleArn === undefined;
          const instanceRoleName = ownsInstanceProfile
            ? (output?.instanceRoleName ??
              (yield* createPhysicalName({ id: `${id}-instance-role`, maxLength: 64 })))
            : undefined;
          const instanceProfileName = ownsInstanceProfile
            ? (output?.instanceProfileName ??
              (yield* createPhysicalName({ id: `${id}-instance-profile`, maxLength: 128 })))
            : undefined;
          const infrastructureRoleName = ownsInfrastructureRole
            ? (output?.infrastructureRoleName ??
              (yield* createPhysicalName({ id: `${id}-infrastructure-role`, maxLength: 64 })))
            : undefined;

          // ECS rejects a Managed Instances provider without security groups.
          const ownsSecurityGroup =
            template !== undefined && !template.networkConfiguration.securityGroups?.length;
          let securityGroupId: string | undefined;
          let taskSecurityGroupId: string | undefined;

          let managedInstances: ecs.CreateManagedInstancesProviderConfiguration | undefined;
          if (news.managedInstancesProvider !== undefined && template !== undefined) {
            const templateSubnets = template.networkConfiguration.subnets ?? [];
            const vpcId = yield* vpcOf(templateSubnets);
            if (ownsSecurityGroup) {
              if (vpcId === undefined) {
                return yield* new CapacityProviderConflict({
                  message: `Can't create a security group for the instances: no VPC found for subnets [${templateSubnets.join(", ")}]`,
                });
              }
              securityGroupId = yield* ensureSecurityGroup(
                yield* createPhysicalName({ id: `${id}-instances`, maxLength: 255 }),
                "Instances of an Amazon ECS Managed Instances capacity provider",
                vpcId,
                internalTags,
                output?.securityGroupId,
              );
            }
            // A group for the tasks that run on the instances. The provider
            // owns it because it outlives every task: delete stops the tasks
            // before it deletes the group.
            if (vpcId !== undefined) {
              taskSecurityGroupId = yield* ensureSecurityGroup(
                yield* createPhysicalName({ id: `${id}-tasks`, maxLength: 255 }),
                "Tasks on an Amazon ECS Managed Instances capacity provider",
                vpcId,
                internalTags,
                output?.taskSecurityGroupId,
              );
            }
            let instanceRoleArn: string | undefined;
            let ec2InstanceProfileArn = template.ec2InstanceProfileArn;
            if (instanceRoleName !== undefined && instanceProfileName !== undefined) {
              instanceRoleArn = yield* ensureRole(
                instanceRoleName,
                "ec2.amazonaws.com",
                internalTags,
              );
              yield* iam.attachRolePolicy({
                RoleName: instanceRoleName,
                PolicyArn: INSTANCE_ROLE_POLICY,
              });
              ec2InstanceProfileArn = yield* ensureInstanceProfile(
                instanceProfileName,
                instanceRoleName,
                internalTags,
              );
            }
            let infrastructureRoleArn = news.managedInstancesProvider.infrastructureRoleArn;
            if (infrastructureRoleName !== undefined) {
              // The role must pass the instance role, whoever created it.
              instanceRoleArn ??= (yield* iam.getInstanceProfile({
                InstanceProfileName: ec2InstanceProfileArn!.split("/").pop()!,
              })).InstanceProfile.Roles[0]?.Arn;
              infrastructureRoleArn = yield* ensureRole(
                infrastructureRoleName,
                "ecs.amazonaws.com",
                internalTags,
              );
              yield* iam.attachRolePolicy({
                RoleName: infrastructureRoleName,
                PolicyArn: INFRASTRUCTURE_ROLE_POLICY,
              });
              if (instanceRoleArn !== undefined) {
                // The managed policy only passes roles named `ecsInstanceRole*`.
                yield* iam.putRolePolicy({
                  RoleName: infrastructureRoleName,
                  PolicyName: "PassInstanceRole",
                  PolicyDocument: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                      {
                        Effect: "Allow",
                        Action: ["iam:PassRole"],
                        Resource: [instanceRoleArn],
                        Condition: { StringLike: { "iam:PassedToService": "ec2.*" } },
                      },
                    ],
                  }),
                });
              }
            }
            managedInstances = {
              ...news.managedInstancesProvider,
              infrastructureRoleArn: infrastructureRoleArn!,
              instanceLaunchTemplate: {
                ...template,
                ec2InstanceProfileArn: ec2InstanceProfileArn!,
                networkConfiguration:
                  securityGroupId === undefined
                    ? template.networkConfiguration
                    : { ...template.networkConfiguration, securityGroups: [securityGroupId] },
                instanceRequirements:
                  template.instanceRequirements ??
                  (template.nitroEnclavesEnabled ? sandboxInstanceRequirements : undefined),
              },
            };
          }

          // Observe — fetch live cloud state. We fetch fresh on every
          // reconcile so adoption, drift, and partial-prior-runs all
          // converge.
          let existing = yield* describe(name, cluster);

          // Ensure — create the capacity provider if missing.
          if (!hasIdentity(existing)) {
            yield* ecs
              .createCapacityProvider({
                name,
                cluster,
                ...(managedInstances
                  ? { managedInstancesProvider: managedInstances }
                  : {
                      autoScalingGroupProvider: {
                        autoScalingGroupArn: news.autoScalingGroupArn as string,
                        managedScaling: news.managedScaling,
                        managedTerminationProtection: news.managedTerminationProtection,
                        managedDraining: news.managedDraining,
                      },
                    }),
                tags: toEcsTags(desiredTags),
              })
              .pipe(
                Effect.retry(retryRolePropagation),
                // ECS may surface concurrent creation either as
                // `LimitExceededException` or a generic `ClientException`
                // with name conflict semantics — re-describe and continue.
                Effect.catchTag("LimitExceededException", () => Effect.void),
              );
            existing = managedInstances
              ? yield* settle(name, cluster, isReady)
              : yield* describe(name, cluster);
          } else if (managedInstances) {
            // Sync — every mutable Managed Instances field, applied as one
            // update. The immutable launch template fields replace (diff).
            const {
              capacityOptionType: _capacityOptionType,
              fipsEnabled: _fipsEnabled,
              nitroEnclavesEnabled: _nitroEnclavesEnabled,
              ...instanceLaunchTemplate
            } = managedInstances.instanceLaunchTemplate;
            const observed = existing.managedInstancesProvider;
            const {
              capacityOptionType: _oc,
              fipsEnabled: _of,
              nitroEnclavesEnabled: _on,
              ...observedTemplate
            } = observed?.instanceLaunchTemplate ?? ({} as ecs.InstanceLaunchTemplate);
            const desired = {
              infrastructureRoleArn: managedInstances.infrastructureRoleArn,
              instanceLaunchTemplate,
              propagateTags: managedInstances.propagateTags,
              infrastructureOptimization: managedInstances.infrastructureOptimization,
              autoRepairConfiguration: managedInstances.autoRepairConfiguration,
            };
            const current = {
              infrastructureRoleArn: observed?.infrastructureRoleArn,
              instanceLaunchTemplate: observedTemplate,
              propagateTags: observed?.propagateTags,
              infrastructureOptimization: observed?.infrastructureOptimization,
              autoRepairConfiguration: observed?.autoRepairConfiguration,
            };
            if (!projects(desired, current)) {
              yield* ecs
                .updateCapacityProvider({
                  name,
                  cluster,
                  managedInstancesProvider: desired,
                })
                .pipe(Effect.retry(retryRolePropagation));
            }
          } else {
            // Sync managed scaling — ECS updateCapacityProvider only mutates
            // managed* fields; the ASG ARN is immutable (replaced in diff).
            yield* ecs.updateCapacityProvider({
              name,
              autoScalingGroupProvider: {
                managedScaling: news.managedScaling,
                managedTerminationProtection: news.managedTerminationProtection,
                managedDraining: news.managedDraining,
              },
            });
          }

          const capacityProviderArn = (existing?.capacityProviderArn ??
            `arn:aws:ecs:${region}:${accountId}:capacity-provider/${name}`) as CapacityProviderArn;

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = fromEcsTags(existing?.tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* ecs.tagResource({
              resourceArn: capacityProviderArn,
              tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* ecs.untagResource({
              resourceArn: capacityProviderArn,
              tagKeys: removed,
            });
          }

          // Re-read to capture status / updateStatus reflecting our changes.
          const found = managedInstances
            ? yield* settle(name, cluster, isReady)
            : yield* describe(name, cluster);
          yield* session.note(capacityProviderArn);

          // IAM this provider created for props that now name their own. The
          // provider has stopped using it by the time the update settles.
          if (output?.instanceProfileName && instanceProfileName === undefined) {
            yield* deleteOwnedInstanceProfile(output.instanceProfileName);
          }
          if (output?.instanceRoleName && instanceRoleName === undefined) {
            yield* deleteOwnedRole(output.instanceRoleName);
          }
          if (output?.infrastructureRoleName && infrastructureRoleName === undefined) {
            yield* deleteOwnedRole(output.infrastructureRoleName);
          }
          // Likewise the security group. Instances launched before the update
          // hold it until ECS replaces them, so a group still in use stays
          // recorded and goes on a later deploy, or with the provider.
          if (output?.securityGroupId && securityGroupId === undefined) {
            const deleted = yield* ec2
              .deleteSecurityGroup({ GroupId: output.securityGroupId })
              .pipe(
                Effect.as(true),
                Effect.catchTags({
                  "InvalidGroup.NotFound": () => Effect.succeed(true),
                  DependencyViolation: () => Effect.succeed(false),
                }),
              );
            if (!deleted) securityGroupId = output.securityGroupId;
          }

          const subnets =
            found !== undefined && subnetsOf(found).length > 0
              ? subnetsOf(found)
              : (managedInstances?.instanceLaunchTemplate.networkConfiguration.subnets ?? []);

          return {
            subnets,
            vpcId: yield* vpcOf(subnets),
            infrastructureRoleName,
            instanceRoleName,
            instanceProfileName,
            securityGroupId,
            taskSecurityGroupId,
            capacityProviderArn,
            name,
            type: found?.type ?? (managedInstances ? "MANAGED_INSTANCES" : "EC2_AUTOSCALING"),
            cluster: found?.cluster ?? cluster,
            status: (found?.status ?? "ACTIVE") as ecs.CapacityProviderStatus,
            updateStatus: found?.updateStatus,
            autoScalingGroupArn:
              found?.autoScalingGroupProvider?.autoScalingGroupArn ??
              news.autoScalingGroupArn ??
              "",
            managedScaling: found?.autoScalingGroupProvider?.managedScaling ?? news.managedScaling,
            managedTerminationProtection:
              found?.autoScalingGroupProvider?.managedTerminationProtection ??
              news.managedTerminationProtection,
            managedDraining:
              found?.autoScalingGroupProvider?.managedDraining ?? news.managedDraining,
            managedInstancesProvider: found?.managedInstancesProvider ?? managedInstances,
            tags: desiredTags,
          };
        }),

        list: () =>
          Effect.gen(function* () {
            // Account-wide providers (ASG-backed) come back without a cluster.
            const collect = (cluster: string | undefined) =>
              describeAll(cluster).pipe(
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
              );
            const accountWide = yield* collect(undefined);
            // Managed Instances providers are only listed per cluster.
            const clusterArns = yield* ecs.listClusters.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk).flatMap((page) => page.clusterArns ?? [])),
            );
            // DescribeCapacityProviders takes a cluster name, not its ARN.
            const clusterNames = clusterArns.map((arn) => arn.split("/").pop()!);
            const perCluster = yield* Effect.forEach(
              clusterNames,
              (clusterName) =>
                collect(clusterName).pipe(
                  Effect.map((providers) =>
                    providers
                      .filter((p) => p.type === "MANAGED_INSTANCES")
                      .map((p) => ({ ...p, cluster: p.cluster ?? clusterName })),
                  ),
                  Effect.catchTag("ClusterNotFoundException", () => Effect.succeed([])),
                ),
              { concurrency: 4 },
            );

            const seen = new Set<string>();
            return [...accountWide, ...perCluster.flat()]
              .filter(hasIdentity)
              .filter(
                (p) =>
                  // FARGATE / FARGATE_SPOT are AWS-managed reserved providers
                  // that this resource does not create or own.
                  p.name !== "FARGATE" && p.name !== "FARGATE_SPOT",
              )
              .filter((p) => {
                if (seen.has(p.capacityProviderArn)) return false;
                seen.add(p.capacityProviderArn);
                return true;
              })
              .map((p) => attrsOf(p, p.cluster));
          }),

        delete: Effect.fn(function* ({ output, session }) {
          if (output.cluster) {
            yield* stopTasks(output.name, output.cluster).pipe(
              // The cluster is gone, and its tasks with it.
              Effect.catchTag("ClusterNotFoundException", () => Effect.void),
            );
          }
          // ECS deletes a Managed Instances provider asynchronously and
          // reports a refusal as DELETE_FAILED, which a task started after
          // the stop above can cause. Stop the tasks and ask again.
          yield* Effect.gen(function* () {
            yield* ecs
              .deleteCapacityProvider({ capacityProvider: output.name, cluster: output.cluster })
              .pipe(
                // Already gone — treat as success.
                Effect.catchTags({
                  InvalidParameterException: () => Effect.void,
                  ClientException: () => Effect.void,
                  ClusterNotFoundException: () => Effect.void,
                  // An earlier delete is still running. Wait for it below.
                  UpdateInProgressException: () => Effect.void,
                }),
              );
            if (!output.cluster) return;
            const cluster = output.cluster;
            const left = yield* settle(
              output.name,
              cluster,
              (p) => p === undefined || p.updateStatus === "DELETE_FAILED",
            );
            if (left === undefined) return;
            yield* stopTasks(output.name, cluster).pipe(
              Effect.catchTag("ClusterNotFoundException", () => Effect.void),
            );
            return yield* new CapacityProviderNotSettled({
              message: `Capacity provider ${output.name} was not deleted${left.updateStatusReason ? `: ${left.updateStatusReason}` : ""}`,
              capacityProvider: output.name,
              status: left.status,
              updateStatus: left.updateStatus,
            });
          }).pipe(
            Effect.retry({
              while: (e) =>
                e._tag === "CapacityProviderNotSettled" && e.updateStatus === "DELETE_FAILED",
              schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(5)]),
            }),
          );
          // The instances are terminated by now, so the IAM the provider
          // created for them can go.
          if (output.instanceProfileName) {
            yield* deleteOwnedInstanceProfile(output.instanceProfileName);
          }
          if (output.instanceRoleName) {
            yield* deleteOwnedRole(output.instanceRoleName);
          }
          if (output.infrastructureRoleName) {
            yield* deleteOwnedRole(output.infrastructureRoleName);
          }
          // The network interfaces of the instances and of the stopped tasks
          // release the security groups a little after they are gone.
          yield* Effect.forEach(
            [output.securityGroupId, output.taskSecurityGroupId].filter(
              (groupId): groupId is string => !!groupId,
            ),
            (groupId) =>
              retryWhileLingeringEnis(
                ec2
                  .deleteSecurityGroup({ GroupId: groupId })
                  .pipe(Effect.catchTag("InvalidGroup.NotFound", () => Effect.void)),
                {
                  scope: { name: "group-id", value: groupId },
                  isDependencyViolation: (e) => e._tag === "DependencyViolation",
                  session,
                },
              ),
            { discard: true, concurrency: 2 },
          );
        }),
      };
    }),
  );

// Compare desired against observed as a projection: keys desired leaves
// unset are ignored, since ECS fills defaults on read.
const projects = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) return false;
    const sorted = (xs: unknown[]) => [...xs].map((x) => JSON.stringify(x)).sort();
    return desired.every((d) => typeof d !== "object")
      ? deepEqual(sorted(desired), sorted(observed))
      : desired.every((d, i) => projects(d, observed[i]));
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([k, v]) =>
      projects(v, (observed as Record<string, unknown>)[k]),
    );
  }
  return desired === observed;
};
