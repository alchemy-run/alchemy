import * as ecs from "@distilled.cloud/aws/ecs";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, diffTags, hasTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type CapacityProviderName = string;
export type CapacityProviderArn =
  `arn:aws:ecs:${RegionID}:${AccountID}:capacity-provider/${CapacityProviderName}`;

/**
 * Configuration of an Amazon ECS Managed Instances capacity provider: ECS
 * launches, patches and scales the EC2 instances itself.
 */
export interface ManagedInstancesProviderProps {
  /**
   * ARN of the infrastructure IAM role ECS assumes to launch and manage the
   * instances. It needs the
   * `AmazonECSInfrastructureRolePolicyForManagedInstances` managed policy and
   * a trust policy for `ecs.amazonaws.com`.
   */
  infrastructureRoleArn: string;
  /**
   * How ECS launches each instance: instance profile, subnets, instance
   * requirements, and whether the instances run Nitro Sandboxes
   * (`nitroEnclavesEnabled`).
   *
   * `capacityOptionType`, `fipsEnabled` and `nitroEnclavesEnabled` can't be
   * changed after creation; changing one replaces the capacity provider.
   */
  instanceLaunchTemplate: ecs.InstanceLaunchTemplate;
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
 * itself. It needs an infrastructure role that ECS assumes and an instance
 * profile for the instances.
 *
 * **Example:** Managed Instances Capacity Provider
 * ```typescript
 * const cluster = yield* Cluster("AppCluster", {});
 *
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
 * a lightweight VM isolated by the Nitro hypervisor. Pick instance types
 * that support Nitro Sandboxes, then set `trustedExecutionConfiguration` on
 * the task definition.
 *
 * **Example:** Capacity for isolated tasks
 * ```typescript
 * const provider = yield* CapacityProvider("SandboxInstances", {
 *   cluster: cluster.clusterName,
 *   managedInstancesProvider: {
 *     infrastructureRoleArn: infrastructureRole.roleArn,
 *     instanceLaunchTemplate: {
 *       ec2InstanceProfileArn: instanceProfile.instanceProfileArn,
 *       networkConfiguration: { subnets: [subnet.subnetId] },
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
  readonly capacityProvider: string;
  readonly status: string | undefined;
}> {}

/** Launch template fields `updateCapacityProvider` can't change. */
const immutableLaunchTemplate = (template: ecs.InstanceLaunchTemplate | undefined) => ({
  capacityOptionType: template?.capacityOptionType,
  fipsEnabled: template?.fipsEnabled ?? false,
  nitroEnclavesEnabled: template?.nitroEnclavesEnabled ?? false,
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

      const attrsOf = (
        found: ecs.CapacityProvider & { name: string; capacityProviderArn: string },
        cluster: string | undefined,
      ): CapacityProvider["Attributes"] => ({
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
                  new CapacityProviderNotSettled({ capacityProvider: name, status: p?.status }),
                ),
          ),
          Effect.retry({
            while: (e) => e._tag === "CapacityProviderNotSettled",
            schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(36)]),
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
          return hasIdentity(found) ? attrsOf(found, cluster) : undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* toName(id, olds ?? {}));
          const cluster = output?.cluster ?? olds?.cluster;
          const found = yield* describe(name, cluster);
          if (!hasIdentity(found)) {
            return undefined;
          }
          const internalTags = yield* createInternalTags(id);
          const attrs = attrsOf(found, cluster);
          return hasTags(internalTags, attrs.tags) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = yield* toName(id, news);
          const cluster = news.cluster;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const managedInstances = news.managedInstancesProvider;

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

          return {
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

        delete: Effect.fn(function* ({ output }) {
          yield* ecs
            .deleteCapacityProvider({ capacityProvider: output.name, cluster: output.cluster })
            .pipe(
              // Already gone — treat as success.
              Effect.catchTags({
                InvalidParameterException: () => Effect.void,
                ClientException: () => Effect.void,
                ClusterNotFoundException: () => Effect.void,
              }),
            );
          if (output.cluster) {
            yield* settle(output.name, output.cluster, (p) => p === undefined);
          }
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
