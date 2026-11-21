import * as iam from "@distilled.cloud/aws/iam";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import { createInternalTags, createTagsList, diffTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";
import { managedPolicyArn } from "../Partition.ts";
import type { Providers } from "../Providers.ts";

/**
 * A target-tracking policy for a capacity provider's `Manual` scaling mode.
 */
export interface CapacityProviderScalingPolicy {
  /**
   * The metric the capacity provider tracks. GPU capacity providers can also
   * track `LambdaCapacityProviderAverageGPUUtilization`.
   */
  predefinedMetricType: Lambda.CapacityProviderPredefinedMetricType;
  /**
   * The utilization percentage (0-100) the capacity provider keeps the metric at.
   */
  targetValue: number;
}

export interface CapacityProviderProps {
  /**
   * Name of the capacity provider, unique within the account and Region.
   * 1-64 letters, numbers, hyphens or underscores. If omitted, a unique name
   * is generated. Changing it replaces the capacity provider.
   */
  capacityProviderName?: string;
  /**
   * Subnets the managed EC2 instances launch in. The instances need outbound
   * access (a public subnet with an internet gateway, a NAT gateway, or VPC
   * endpoints) to reach AWS services and to send logs to CloudWatch.
   * Changing them replaces the capacity provider.
   */
  subnetIds: string[];
  /**
   * Security groups attached to the managed EC2 instances. Changing them
   * replaces the capacity provider.
   */
  securityGroupIds: string[];
  /**
   * ARN of the operator role Lambda assumes to launch, terminate and monitor
   * the EC2 instances. If omitted, Alchemy creates a role with the
   * `AWSLambdaManagedEC2ResourceOperator` managed policy and deletes it with
   * the capacity provider. Changing it replaces the capacity provider.
   */
  operatorRole?: string;
  /**
   * Instruction set of the instances. Functions on this capacity provider
   * must use the same `architecture`. Changing it replaces the capacity
   * provider.
   * @default "x86_64"
   */
  architecture?: Lambda.Architecture;
  /**
   * EC2 instance types Lambda may launch, e.g. `["g6.xlarge", "g5.xlarge"]`
   * or `["m7a.*"]`. List only GPU instance types (G4dn, G5, G6, Gr6, G6e,
   * G6f, Gr6f) to run GPU-accelerated functions; a capacity provider cannot
   * mix GPU and non-GPU types. If omitted, Lambda chooses general-purpose
   * instance types. Changing it replaces the capacity provider.
   */
  allowedInstanceTypes?: string[];
  /**
   * EC2 instance types Lambda must not launch. Changing it replaces the
   * capacity provider.
   */
  excludedInstanceTypes?: string[];
  /**
   * Maximum total vCPUs across the instances this capacity provider runs
   * (2-15000). Each instance type consumes a fixed number of vCPUs (for
   * example `g6.4xlarge` uses 16), so this caps how many instances can run.
   */
  maxVCpuCount?: number;
  /**
   * `Auto` lets Lambda pick the scaling targets. `Manual` uses
   * {@link scalingPolicies}.
   * @default "Auto"
   */
  scalingMode?: Lambda.CapacityProviderScalingMode;
  /**
   * Target-tracking policies for `scalingMode: "Manual"`.
   */
  scalingPolicies?: CapacityProviderScalingPolicy[];
  /**
   * KMS key that encrypts the instances' EBS volumes. Changing it replaces the
   * capacity provider.
   */
  kmsKeyArn?: string;
  /**
   * Tags to apply to the capacity provider.
   */
  tags?: Record<string, string>;
}

export interface CapacityProvider extends Resource<
  "AWS.Lambda.CapacityProvider",
  CapacityProviderProps,
  {
    /** ARN of the capacity provider. Pass it to a Function's `capacityProvider`. */
    capacityProviderArn: string;
    /** Name of the capacity provider. */
    capacityProviderName: string;
    /** State of the capacity provider (`Pending`, `Active`, `Failed`, `Deleting`). */
    state: Lambda.CapacityProviderState;
    /** ARN of the operator role Lambda assumes to manage the instances. */
    operatorRoleArn: string;
    /**
     * Name of the operator role Alchemy created, or `undefined` when the
     * role was passed in as `operatorRole`.
     */
    operatorRoleName: string | undefined;
    /** Instruction set of the instances. */
    architecture: Lambda.Architecture | undefined;
    /** Instance types Lambda may launch. */
    allowedInstanceTypes: string[] | undefined;
    /** Maximum total vCPUs across the instances. */
    maxVCpuCount: number | undefined;
  },
  never,
  Providers
> {}

export class CapacityProviderFailed extends Data.TaggedError("CapacityProviderFailed")<{
  capacityProviderName: string;
  message: string;
}> {}

class CapacityProviderNotSettled extends Data.TaggedError("CapacityProviderNotSettled")<{
  state: string | undefined;
}> {}

/**
 * A Lambda Managed Instances capacity provider: a pool of EC2 instances in
 * your VPC that Lambda launches, patches, scales and terminates for the
 * functions attached to it. Functions opt in with `capacityProvider`, and
 * Lambda runs several invocations at once in each execution environment.
 *
 * List GPU instance types in `allowedInstanceTypes` to run GPU-accelerated
 * functions: each execution environment gets one GPU (or one GPU fraction on
 * G6f/Gr6f), and Lambda manages the NVIDIA drivers. GPU instances count
 * against the EC2 "Running On-Demand G and VT instances" quota, which
 * defaults to 0 vCPUs.
 *
 * Instances are billed at EC2 On-Demand prices while they run. A function
 * on a capacity provider keeps a minimum number of execution environments
 * running (1 for GPU functions, 3 otherwise) unless you set
 * `minExecutionEnvironments: 0` on the function to scale to zero.
 *
 * ### Creating a Capacity Provider
 * **Example:** General-purpose instances
 * ```typescript
 * const pool = yield* AWS.Lambda.CapacityProvider("Pool", {
 *   subnetIds: [subnet.subnetId],
 *   securityGroupIds: [securityGroup.groupId],
 *   allowedInstanceTypes: ["m7a.large"],
 *   maxVCpuCount: 16,
 * });
 * ```
 *
 * ### GPU Instances
 * **Example:** A GPU capacity provider with fallback across generations
 * ```typescript
 * const gpus = yield* AWS.Lambda.CapacityProvider("Gpus", {
 *   subnetIds: [subnet.subnetId],
 *   securityGroupIds: [securityGroup.groupId],
 *   allowedInstanceTypes: ["g6.xlarge", "g5.xlarge", "g4dn.xlarge"],
 *   maxVCpuCount: 16,
 * });
 *
 * const infer = yield* AWS.Lambda.Function("Infer", {
 *   image: { context: "./model", dockerfile: "Dockerfile" },
 *   architecture: "x86_64",
 *   capacityProvider: gpus,
 *   acceleratorMemorySize: 16,
 *   memorySize: 8192,
 *   timeout: Duration.minutes(5),
 * });
 * ```
 *
 * ### Bringing an Operator Role
 * **Example:** Use an existing operator role
 * ```typescript
 * const pool = yield* AWS.Lambda.CapacityProvider("Pool", {
 *   subnetIds: [subnet.subnetId],
 *   securityGroupIds: [securityGroup.groupId],
 *   operatorRole: operator.roleArn,
 * });
 * ```
 *
 * @resource
 */
export const CapacityProvider = Resource<CapacityProvider>("AWS.Lambda.CapacityProvider");

const operatorPolicyName = "AWSLambdaManagedEC2ResourceOperator";

const resolveName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 64 });

const resolveOperatorRoleName = (id: string) =>
  createPhysicalName({ id: `${id}-operator`, maxLength: 64 });

const getCapacityProvider = (name: string) =>
  Lambda.getCapacityProvider({ CapacityProviderName: name }).pipe(
    Effect.map((r) => r.CapacityProvider),
    Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
  );

const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort();

const desiredScaling = (props: CapacityProviderProps): Lambda.CapacityProviderScalingConfig => ({
  MaxVCpuCount: props.maxVCpuCount,
  ScalingMode: props.scalingMode ?? (props.scalingPolicies ? "Manual" : "Auto"),
  ScalingPolicies: props.scalingPolicies?.map((policy) => ({
    PredefinedMetricType: policy.predefinedMetricType,
    TargetValue: policy.targetValue,
  })),
});

// Properties UpdateCapacityProvider cannot change.
const immutableShape = (props: CapacityProviderProps) => ({
  subnetIds: sorted(props.subnetIds),
  securityGroupIds: sorted(props.securityGroupIds),
  operatorRole: props.operatorRole,
  architecture: props.architecture ?? "x86_64",
  allowedInstanceTypes: sorted(props.allowedInstanceTypes),
  excludedInstanceTypes: sorted(props.excludedInstanceTypes),
  kmsKeyArn: props.kmsKeyArn,
});

const toAttrs = (
  provider: Lambda.CapacityProvider,
  operatorRoleName: string | undefined,
): CapacityProvider["Attributes"] => ({
  capacityProviderArn: provider.CapacityProviderArn,
  capacityProviderName: provider.CapacityProviderArn.split(":").pop()!,
  state: provider.State,
  operatorRoleArn: provider.PermissionsConfig.CapacityProviderOperatorRoleArn,
  operatorRoleName,
  architecture: provider.InstanceRequirements?.Architectures?.[0],
  allowedInstanceTypes: provider.InstanceRequirements?.AllowedInstanceTypes,
  maxVCpuCount: provider.CapacityProviderScalingConfig?.MaxVCpuCount,
});

const waitForSettled = (name: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const provider = yield* getCapacityProvider(name);
    if (provider?.State === "Active") return provider;
    if (provider?.State === "Failed") {
      return yield* new CapacityProviderFailed({
        capacityProviderName: name,
        message: `Capacity provider ${name} entered the Failed state`,
      });
    }
    return yield* new CapacityProviderNotSettled({ state: provider?.State });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "CapacityProviderNotSettled",
      schedule: Schedule.spaced("2 seconds").pipe(
        Schedule.tap(() => session.note(`Waiting for capacity provider ${name} to become Active`)),
      ),
      times: 60,
    }),
  );

const ensureOperatorRole = Effect.fn(function* (id: string, roleName: string) {
  const { partition } = yield* AWSEnvironment.current;
  let role = yield* iam
    .getRole({ RoleName: roleName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.undefined));
  if (role === undefined) {
    role = yield* iam
      .createRole({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        Tags: createTagsList(yield* createInternalTags(id)),
      })
      .pipe(
        Effect.catchTag("EntityAlreadyExistsException", () => iam.getRole({ RoleName: roleName })),
      );
  }
  yield* iam.attachRolePolicy({
    RoleName: roleName,
    PolicyArn: managedPolicyArn(partition, operatorPolicyName),
  });
  return role.Role.Arn;
});

const deleteOperatorRole = Effect.fn(function* (roleName: string) {
  const { partition } = yield* AWSEnvironment.current;
  yield* iam
    .detachRolePolicy({
      RoleName: roleName,
      PolicyArn: managedPolicyArn(partition, operatorPolicyName),
    })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
  yield* iam.deleteRole({ RoleName: roleName }).pipe(
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
    Effect.retry({
      while: (e) =>
        e._tag === "DeleteConflictException" || e._tag === "ConcurrentModificationException",
      schedule: Schedule.spaced("2 seconds"),
      times: 10,
    }),
  );
});

export const CapacityProviderProvider = () =>
  Provider.succeed(CapacityProvider, {
    stables: ["capacityProviderArn", "capacityProviderName", "operatorRoleArn", "operatorRoleName"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return;
      const name = news.capacityProviderName ?? output?.capacityProviderName;
      if (name !== undefined && output !== undefined && name !== output.capacityProviderName) {
        return { action: "replace" } as const;
      }
      if (!deepEqual(immutableShape(olds), immutableShape(news))) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name =
        output?.capacityProviderName ?? (yield* resolveName(id, olds?.capacityProviderName));
      const provider = yield* getCapacityProvider(name);
      if (provider === undefined) return undefined;
      const attrs = toAttrs(provider, output?.operatorRoleName);
      const tags = yield* Lambda.listTags({ Resource: provider.CapacityProviderArn }).pipe(
        Effect.map((r) => r.Tags ?? {}),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed({})),
      );
      return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Lambda.listCapacityProviders.items({}).pipe(
        Stream.filter((provider) => provider.State !== "Deleting"),
        Stream.map((provider) => toAttrs(provider, undefined)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name =
        output?.capacityProviderName ?? (yield* resolveName(id, news.capacityProviderName));
      const internalTags = yield* createInternalTags(id);
      const desiredTags = { ...news.tags, ...internalTags };

      // Observe
      const observed = yield* getCapacityProvider(name);

      // Ensure — the operator role is ours only when the user didn't bring one.
      const operatorRoleName = news.operatorRole
        ? undefined
        : (output?.operatorRoleName ?? (yield* resolveOperatorRoleName(id)));
      const operatorRoleArn =
        news.operatorRole ?? (yield* ensureOperatorRole(id, operatorRoleName!));

      if (observed === undefined || observed.State === "Failed") {
        if (observed?.State === "Failed") {
          yield* Lambda.deleteCapacityProvider({ CapacityProviderName: name }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          yield* waitForGone(name, session);
        }
        yield* session.note(`Creating capacity provider ${name}`);
        yield* Lambda.createCapacityProvider({
          CapacityProviderName: name,
          VpcConfig: { SubnetIds: news.subnetIds, SecurityGroupIds: news.securityGroupIds },
          PermissionsConfig: { CapacityProviderOperatorRoleArn: operatorRoleArn },
          InstanceRequirements: {
            Architectures: [news.architecture ?? "x86_64"],
            AllowedInstanceTypes: news.allowedInstanceTypes,
            ExcludedInstanceTypes: news.excludedInstanceTypes,
          },
          CapacityProviderScalingConfig: desiredScaling(news),
          KmsKeyArn: news.kmsKeyArn,
          Tags: desiredTags,
        }).pipe(
          // A just-created operator role, subnet or security group is
          // briefly invisible to Lambda.
          Effect.retry({
            while: (e) =>
              e._tag === "CapacityProviderOperatorRoleNotAssumable" ||
              e._tag === "CapacityProviderSecurityGroupNotFound" ||
              e._tag === "CapacityProviderSubnetNotFound",
            schedule: Schedule.spaced("2 seconds").pipe(
              Schedule.tap(() =>
                session.note(`Waiting for the operator role and network of ${name} to propagate`),
              ),
            ),
            times: 30,
          }),
          // Created by a concurrent or interrupted reconcile.
          Effect.catchTag("ResourceConflictException", () => Effect.void),
          // Nothing is persisted when the first create fails, so no delete
          // would ever remove the operator role made for it.
          Effect.tapError(() =>
            output === undefined && operatorRoleName !== undefined
              ? deleteOperatorRole(operatorRoleName).pipe(Effect.ignore)
              : Effect.void,
          ),
        );
      }

      let provider = yield* waitForSettled(name, session);

      // Sync scaling — the only aspect UpdateCapacityProvider changes.
      const scaling = desiredScaling(news);
      const observedScaling = provider.CapacityProviderScalingConfig;
      // Lambda fills in its own MaxVCpuCount (and Auto-mode policies) when
      // they're omitted, so only compare what the props pin down.
      const scalingInSync =
        (news.maxVCpuCount === undefined || observedScaling?.MaxVCpuCount === news.maxVCpuCount) &&
        (observedScaling?.ScalingMode ?? "Auto") === scaling.ScalingMode &&
        (scaling.ScalingMode !== "Manual" ||
          deepEqual(observedScaling?.ScalingPolicies ?? [], scaling.ScalingPolicies ?? []));
      if (!scalingInSync) {
        yield* session.note(`Updating capacity provider ${name} scaling`);
        yield* Lambda.updateCapacityProvider({
          CapacityProviderName: name,
          CapacityProviderScalingConfig: scaling,
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "ResourceConflictException",
            schedule: Schedule.spaced("2 seconds"),
            times: 30,
          }),
        );
        provider = yield* waitForSettled(name, session);
      }

      // Sync tags against the observed cloud tags.
      const observedTags = yield* Lambda.listTags({ Resource: provider.CapacityProviderArn }).pipe(
        Effect.map((r) =>
          Object.fromEntries(
            Object.entries(r.Tags ?? {}).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, value] as const],
            ),
          ),
        ),
      );
      const { removed, upsert } = diffTags(observedTags, desiredTags);
      if (upsert.length > 0) {
        yield* Lambda.tagResource({
          Resource: provider.CapacityProviderArn,
          Tags: Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
        });
      }
      if (removed.length > 0) {
        yield* Lambda.untagResource({ Resource: provider.CapacityProviderArn, TagKeys: removed });
      }

      return toAttrs(provider, operatorRoleName);
    }),

    delete: Effect.fn(function* ({ output, session }) {
      const name = output.capacityProviderName;
      yield* session.note(`Deleting capacity provider ${name}`);
      yield* Lambda.deleteCapacityProvider({ CapacityProviderName: name }).pipe(
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        // Functions that were just deleted still hold their versions on the
        // capacity provider while Lambda drains them.
        Effect.retry({
          while: (e) => e._tag === "ResourceConflictException",
          schedule: Schedule.spaced("10 seconds").pipe(
            Schedule.tap(() =>
              session.note(`Waiting for functions to detach from capacity provider ${name}`),
            ),
          ),
          times: 60,
        }),
      );
      yield* waitForGone(name, session);
      if (output.operatorRoleName !== undefined) {
        yield* deleteOperatorRole(output.operatorRoleName);
      }
    }),
  });

const waitForGone = (name: string, session: ScopedPlanStatusSession) =>
  getCapacityProvider(name).pipe(
    Effect.flatMap((provider) =>
      provider === undefined
        ? Effect.void
        : Effect.fail(new CapacityProviderNotSettled({ state: provider.State })),
    ),
    Effect.retry({
      while: (e) => e._tag === "CapacityProviderNotSettled",
      schedule: Schedule.spaced("5 seconds").pipe(
        Schedule.tap(() => session.note(`Waiting for capacity provider ${name} to be deleted`)),
      ),
      times: 120,
    }),
  );
