import * as batch from "@distilled.cloud/aws/batch";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { pollBatch, retryBatch } from "./internal.ts";

export type ComputeEnvironmentName = string;
export type ComputeEnvironmentArn =
  `arn:aws:batch:${RegionID}:${AccountID}:compute-environment/${ComputeEnvironmentName}`;

/**
 * Raised when networking is left implicit but the account/region has no
 * default VPC to fall back to.
 */
export class NoDefaultVpcError extends Data.TaggedError("NoDefaultVpcError")<{
  readonly message: string;
}> {}

/**
 * Raised when AWS Batch finishes reconciling a compute environment in an
 * unusable state. The status reason is preserved so callers see the actual
 * AWS configuration or dependency failure instead of receiving stale
 * `status: "INVALID"` attributes from a successful deployment.
 */
export class ComputeEnvironmentInvalidError extends Data.TaggedError(
  "ComputeEnvironmentInvalidError",
)<{
  readonly computeEnvironmentName: string;
  readonly status: string;
  readonly statusReason: string | undefined;
  readonly message: string;
}> {}

export interface ComputeEnvironmentProps {
  /**
   * Name of the compute environment. If omitted, a unique name is generated.
   * Up to 128 characters (letters, numbers, hyphens, underscores).
   */
  computeEnvironmentName?: string;
  /**
   * Whether AWS Batch manages the compute capacity. Unmanaged environments
   * are useful when capacity is registered separately, and do not require
   * subnets or security groups.
   * Changing this replaces the compute environment.
   * @default "MANAGED"
   */
  managementType?: "MANAGED" | "UNMANAGED";
  /**
   * Fargate capacity type for the managed compute environment.
   * Changing this replaces the compute environment.
   * @default "FARGATE"
   */
  type?: "FARGATE" | "FARGATE_SPOT";
  /**
   * Maximum number of Fargate vCPUs the environment can scale to.
   * @default 4
   */
  maxvCpus?: number;
  /**
   * Number of externally-managed vCPUs available to an unmanaged compute
   * environment.
   * @default 4
   */
  unmanagedvCpus?: number;
  /**
   * VPC subnets the Fargate tasks run in. If omitted, the default VPC's
   * subnets are used.
   */
  subnets?: string[];
  /**
   * Security groups for the Fargate tasks. If omitted, the default VPC's
   * default security group is used.
   */
  securityGroupIds?: string[];
  /**
   * Whether the compute environment accepts jobs from associated queues.
   * @default "ENABLED"
   */
  state?: "ENABLED" | "DISABLED";
  /**
   * Service role ARN. If omitted, AWS Batch uses (and auto-creates on first
   * use) the `AWSServiceRoleForBatch` service-linked role.
   */
  serviceRole?: string;
  /**
   * User-defined tags to apply to the compute environment.
   */
  tags?: Record<string, string>;
}

export interface ComputeEnvironment extends Resource<
  "AWS.Batch.ComputeEnvironment",
  ComputeEnvironmentProps,
  {
    computeEnvironmentName: ComputeEnvironmentName;
    computeEnvironmentArn: ComputeEnvironmentArn;
    ecsClusterArn: string | undefined;
    managementType: "MANAGED" | "UNMANAGED";
    type: "FARGATE" | "FARGATE_SPOT";
    state: "ENABLED" | "DISABLED";
    status: string;
    maxvCpus: number;
    unmanagedvCpus: number;
    subnets: string[];
    securityGroupIds: string[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Batch managed compute environment backed by Fargate (or Fargate
 * Spot) capacity. Fargate compute environments provision in seconds and
 * require no instance management.
 *
 * @resource
 * @section Creating Compute Environments
 * @example Default Fargate Compute Environment
 * ```typescript
 * // Uses the default VPC's subnets and default security group.
 * const ce = yield* Batch.ComputeEnvironment("JobsCE", {});
 * ```
 *
 * @example Unmanaged Compute Environment
 * ```typescript
 * const ce = yield* Batch.ComputeEnvironment("ExternalCapacity", {
 *   managementType: "UNMANAGED",
 *   unmanagedvCpus: 8,
 * });
 * ```
 *
 * @example Fargate Spot with explicit networking
 * ```typescript
 * const ce = yield* Batch.ComputeEnvironment("SpotCE", {
 *   type: "FARGATE_SPOT",
 *   maxvCpus: 16,
 *   subnets: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroupIds: [sg.groupId],
 * });
 * ```
 *
 * @section Composing the Batch chain
 * @example Compute Environment → Job Queue
 * ```typescript
 * const ce = yield* Batch.ComputeEnvironment("JobsCE", {});
 * const queue = yield* Batch.JobQueue("JobsQueue", {
 *   computeEnvironments: [ce.computeEnvironmentArn],
 * });
 * ```
 */
export const ComputeEnvironment = Resource<ComputeEnvironment>(
  "AWS.Batch.ComputeEnvironment",
);

const toAttributes = (
  ce: batch.ComputeEnvironmentDetail,
  tags: Record<string, string>,
) => ({
  computeEnvironmentName: ce.computeEnvironmentName!,
  computeEnvironmentArn: ce.computeEnvironmentArn as ComputeEnvironmentArn,
  ecsClusterArn: ce.ecsClusterArn,
  managementType: (ce.type ?? "MANAGED") as "MANAGED" | "UNMANAGED",
  type: (ce.computeResources?.type ?? "FARGATE") as "FARGATE" | "FARGATE_SPOT",
  state: (ce.state ?? "ENABLED") as "ENABLED" | "DISABLED",
  status: ce.status ?? "VALID",
  maxvCpus: ce.computeResources?.maxvCpus ?? 0,
  unmanagedvCpus: ce.unmanagedvCpus ?? 0,
  subnets: [...(ce.computeResources?.subnets ?? [])],
  securityGroupIds: [...(ce.computeResources?.securityGroupIds ?? [])],
  tags,
});

const observedTagsOf = (ce: { tags?: { [key: string]: string | undefined } }) =>
  Object.fromEntries(
    Object.entries(ce.tags ?? {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );

/**
 * Resolve the default VPC's subnets and default security group — used when
 * the user doesn't pin networking explicitly.
 */
const resolveDefaultNetwork = Effect.gen(function* () {
  const vpcs = yield* ec2.describeVpcs({
    Filters: [{ Name: "is-default", Values: ["true"] }],
  });
  const vpcId = vpcs.Vpcs?.find(
    (vpc) => vpc.State === undefined || vpc.State === "available",
  )?.VpcId;
  if (!vpcId) {
    return yield* Effect.fail(
      new NoDefaultVpcError({
        message:
          "No default VPC found — pass `subnets` and `securityGroupIds` explicitly",
      }),
    );
  }
  const subnets = yield* ec2.describeSubnets({
    Filters: [{ Name: "vpc-id", Values: [vpcId] }],
  });
  const groups = yield* ec2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const network = {
    subnets: (subnets.Subnets ?? []).flatMap((s) =>
      s.SubnetId && (s.State === undefined || s.State === "available")
        ? [s.SubnetId]
        : [],
    ),
    securityGroupIds: (groups.SecurityGroups ?? []).flatMap((g) =>
      g.GroupId ? [g.GroupId] : [],
    ),
  };
  if (network.subnets.length === 0 || network.securityGroupIds.length === 0) {
    return yield* Effect.fail(
      new NoDefaultVpcError({
        message:
          "Default VPC networking is not ready — pass `subnets` and `securityGroupIds` explicitly",
      }),
    );
  }
  return network;
}).pipe(
  Effect.retry({
    while: (error) => error._tag === "NoDefaultVpcError",
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(10)]),
  }),
);

export const ComputeEnvironmentProvider = () =>
  Provider.effect(
    ComputeEnvironment,
    Effect.gen(function* () {
      const toName = (id: string, props: ComputeEnvironmentProps = {}) =>
        props.computeEnvironmentName
          ? Effect.succeed(props.computeEnvironmentName)
          : createPhysicalName({ id, maxLength: 128 });

      // A deleted environment lingers as a DELETED record for a while and the
      // name is immediately reusable, so a describe-by-name can briefly
      // return both the tombstone and the live one — prefer the live one.
      const describeOne = (name: string) =>
        batch
          .describeComputeEnvironments({ computeEnvironments: [name] })
          .pipe(
            Effect.map(
              (res) =>
                res.computeEnvironments?.find(
                  (ce) => ce.status !== "DELETED",
                ) ?? res.computeEnvironments?.[0],
            ),
          );

      /** Wait until any CREATING/UPDATING/DELETING transition settles. */
      const awaitSettled = (name: string) =>
        pollBatch(
          describeOne(name),
          (ce) =>
            ce === undefined ||
            (ce.status !== "CREATING" &&
              ce.status !== "UPDATING" &&
              ce.status !== "DELETING"),
        );

      const awaitDisabled = (name: string) =>
        pollBatch(
          describeOne(name),
          (ce) =>
            ce === undefined ||
            ce.status === "DELETED" ||
            ce.status === "DELETING" ||
            (ce.state === "DISABLED" &&
              ce.status !== "CREATING" &&
              ce.status !== "UPDATING"),
        );

      const invalid = (
        name: string,
        ce: batch.ComputeEnvironmentDetail | undefined,
      ) => {
        const status = ce?.status ?? "MISSING";
        const statusReason = ce?.statusReason;
        return new ComputeEnvironmentInvalidError({
          computeEnvironmentName: name,
          status,
          statusReason,
          message: `Compute environment ${name} settled as ${status}${statusReason ? `: ${statusReason}` : ""}`,
        });
      };

      /**
       * A force nuke cannot rely on stack dependency ordering: a listed
       * compute environment may still be attached to a separately-listed job
       * queue. Delete those blockers first. Ordinary stack deletion never
       * touches out-of-band queues.
       */
      const deleteRelatedJobQueues = (computeEnvironment: string) =>
        Effect.gen(function* () {
          const pages = yield* batch.describeJobQueues
            .pages({})
            .pipe(Stream.runCollect);
          const queues = Array.from(pages)
            .flatMap((page) => page.jobQueues ?? [])
            .filter(
              (queue) =>
                queue.jobQueueName &&
                queue.status !== "DELETED" &&
                queue.computeEnvironmentOrder?.some(
                  (entry) =>
                    entry.computeEnvironment === computeEnvironment ||
                    entry.computeEnvironment?.endsWith(
                      `:compute-environment/${computeEnvironment}`,
                    ),
                ),
            );

          yield* Effect.forEach(
            queues,
            (queue) =>
              Effect.gen(function* () {
                const queueName = queue.jobQueueName!;
                const describeQueue = batch
                  .describeJobQueues({ jobQueues: [queueName] })
                  .pipe(
                    Effect.map((response) =>
                      response.jobQueues?.find(
                        (candidate) => candidate.status !== "DELETED",
                      ),
                    ),
                  );
                let observed = yield* describeQueue;
                if (!observed) return;
                if (
                  observed.status !== "DELETING" &&
                  (observed.state ?? "ENABLED") !== "DISABLED"
                ) {
                  yield* retryBatch(
                    batch.updateJobQueue({
                      jobQueue: queueName,
                      state: "DISABLED",
                    }),
                    (error) => error._tag === "JobQueueBeingModified",
                  ).pipe(
                    Effect.catchTag("JobQueueNotFound", () => Effect.void),
                  );
                }
                observed = yield* pollBatch(
                  describeQueue,
                  (candidate) =>
                    candidate === undefined ||
                    candidate.status === "DELETED" ||
                    candidate.status === "DELETING" ||
                    (candidate.state === "DISABLED" &&
                      (candidate.status === "VALID" ||
                        candidate.status === "INVALID")),
                );
                if (!observed || observed.status === "DELETED") return;
                if (observed.status !== "DELETING") {
                  yield* retryBatch(
                    batch.deleteJobQueue({ jobQueue: queueName }),
                    (error) => error._tag === "JobQueueBeingModified",
                  ).pipe(
                    Effect.catchTag("JobQueueNotFound", () => Effect.void),
                  );
                }
                yield* pollBatch(
                  describeQueue,
                  (candidate) =>
                    candidate === undefined || candidate.status === "DELETED",
                );
              }),
            { concurrency: 4, discard: true },
          );
        });

      return {
        stables: ["computeEnvironmentName", "computeEnvironmentArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.type ?? "FARGATE") !== (news?.type ?? "FARGATE")) {
            return { action: "replace" } as const;
          }
          if (
            (olds?.managementType ?? "MANAGED") !==
            (news?.managementType ?? "MANAGED")
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.computeEnvironmentName ?? (yield* toName(id, olds ?? {}));
          const ce = yield* describeOne(name);
          if (!ce?.computeEnvironmentArn || ce.status === "DELETED") {
            return undefined;
          }
          return toAttributes(ce, observedTagsOf(ce));
        }),
        list: () =>
          Effect.gen(function* () {
            const pages = yield* batch.describeComputeEnvironments
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.computeEnvironments ?? [])
              .flatMap((ce) =>
                ce.computeEnvironmentArn && ce.status !== "DELETED"
                  ? [toAttributes(ce, observedTagsOf(ce))]
                  : [],
              );
          }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.computeEnvironmentName ?? (yield* toName(id, news));
          const arn =
            `arn:aws:batch:${region}:${accountId}:compute-environment/${name}` as ComputeEnvironmentArn;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredState = news.state ?? "ENABLED";
          const desiredManagementType = news.managementType ?? "MANAGED";
          const desiredMaxvCpus = news.maxvCpus ?? 4;
          const desiredUnmanagedvCpus = news.unmanagedvCpus ?? 4;
          // Implicit networking means the *current* default VPC network, not
          // whichever subnet IDs happened to exist at create time. Account
          // cleanup can recreate the default VPC between reconciliations, so
          // resolve the desired network on every pass and repair stale IDs.
          const fallbackNetwork =
            desiredManagementType === "MANAGED" &&
            (!news.subnets || !news.securityGroupIds)
              ? yield* resolveDefaultNetwork
              : undefined;
          let desiredNetwork =
            desiredManagementType === "MANAGED"
              ? {
                  subnets: news.subnets ?? fallbackNetwork!.subnets,
                  securityGroupIds:
                    news.securityGroupIds ?? fallbackNetwork!.securityGroupIds,
                }
              : undefined;
          const sameSet = (a: readonly string[], b: readonly string[]) =>
            a.length === b.length &&
            [...a].sort().join(",") === [...b].sort().join(",");
          const matchesDesired = (candidate: batch.ComputeEnvironmentDetail) =>
            (candidate.type ?? "MANAGED") === desiredManagementType &&
            (candidate.state ?? "ENABLED") === desiredState &&
            (desiredManagementType === "UNMANAGED"
              ? (candidate.unmanagedvCpus ?? 0) === desiredUnmanagedvCpus
              : (candidate.computeResources?.maxvCpus ?? 0) ===
                  desiredMaxvCpus &&
                sameSet(
                  candidate.computeResources?.subnets ?? [],
                  desiredNetwork!.subnets,
                ) &&
                sameSet(
                  candidate.computeResources?.securityGroupIds ?? [],
                  desiredNetwork!.securityGroupIds,
                ));

          /**
           * INVALID is terminal until the configuration is changed. It is
           * commonly caused by default-VPC subnet/security-group churn during
           * highly concurrent account tests, so waiting on the same observed
           * configuration cannot recover. Re-resolve implicit networking and
           * submit a bounded repair update instead.
           */
          const awaitValid = Effect.fn(function* () {
            let lastRepairNetwork: string | undefined;
            for (let attempt = 0; attempt < 8; attempt++) {
              const settled = yield* awaitSettled(name);
              if (settled?.status === "VALID" && matchesDesired(settled)) {
                return settled;
              }
              if (!settled || settled.status === "DELETED" || attempt === 7) {
                return yield* Effect.fail(invalid(name, settled));
              }

              if (
                desiredManagementType === "MANAGED" &&
                (!news.subnets || !news.securityGroupIds)
              ) {
                const refreshed = yield* resolveDefaultNetwork;
                desiredNetwork = {
                  subnets: news.subnets ?? refreshed.subnets,
                  securityGroupIds:
                    news.securityGroupIds ?? refreshed.securityGroupIds,
                };
              }
              const repairNetwork = [
                desiredManagementType,
                "|",
                ...(desiredNetwork
                  ? [
                      ...[...desiredNetwork.subnets].sort(),
                      "|",
                      ...[...desiredNetwork.securityGroupIds].sort(),
                    ]
                  : [desiredUnmanagedvCpus]),
              ].join(",");
              if (lastRepairNetwork === repairNetwork) {
                // EC2 may briefly keep returning a just-deleted default VPC
                // network. Do not spend the repair budget re-submitting the
                // same known-invalid IDs; wait for EC2's replacement view.
                yield* Effect.sleep("5 seconds");
                continue;
              }
              yield* retryBatch(
                batch.updateComputeEnvironment({
                  computeEnvironment: name,
                  state: desiredState,
                  unmanagedvCpus:
                    desiredManagementType === "UNMANAGED"
                      ? desiredUnmanagedvCpus
                      : undefined,
                  computeResources:
                    desiredManagementType === "MANAGED"
                      ? {
                          maxvCpus: desiredMaxvCpus,
                          subnets: desiredNetwork!.subnets,
                          securityGroupIds: desiredNetwork!.securityGroupIds,
                        }
                      : undefined,
                }),
                (error) => error._tag === "ComputeEnvironmentBeingModified",
              );
              lastRepairNetwork = repairNetwork;
              // Describe can briefly return the pre-update record before the
              // transition becomes visible.
              yield* Effect.sleep("3 seconds");
            }
            return yield* Effect.fail(invalid(name, undefined));
          });

          // Observe — cloud state is authoritative.
          let ce = yield* describeOne(name);
          if (ce?.status === "DELETED") ce = undefined;

          // Ensure — create if missing, then wait until the environment
          // settles to VALID (Fargate CEs settle in seconds).
          const create = Effect.gen(function* () {
            yield* batch.createComputeEnvironment({
              computeEnvironmentName: name,
              type: desiredManagementType,
              state: desiredState,
              unmanagedvCpus:
                desiredManagementType === "UNMANAGED"
                  ? desiredUnmanagedvCpus
                  : undefined,
              computeResources:
                desiredManagementType === "MANAGED"
                  ? {
                      type: news.type ?? "FARGATE",
                      maxvCpus: desiredMaxvCpus,
                      subnets: desiredNetwork!.subnets,
                      securityGroupIds: desiredNetwork!.securityGroupIds,
                    }
                  : undefined,
              serviceRole: news.serviceRole,
              tags: desiredTags,
            });
          });

          if (ce?.computeEnvironmentArn && ce.status === "DELETING") {
            // An interrupted destroy left the environment mid-deletion — let
            // it finish, then fall through to a fresh create below.
            ce = yield* awaitSettled(name);
            if (ce?.status === "DELETED") ce = undefined;
          }
          if (!ce?.computeEnvironmentArn) {
            yield* create;
            ce = yield* awaitSettled(name);
          } else if (ce.status !== "VALID" && ce.status !== "INVALID") {
            // A prior modification is still settling — wait before diffing.
            ce = yield* awaitSettled(name);
          }
          if (ce?.status === "DELETED") {
            // The settle above can still land on a tombstone (deletion that
            // completed between observe and settle) — one more create pass.
            yield* create;
            ce = yield* awaitSettled(name);
          }

          if (!ce?.computeEnvironmentArn) {
            return yield* Effect.die(
              new Error(`ComputeEnvironment ${name} did not settle`),
            );
          }

          // Sync — diff observed against desired, apply only the delta.
          const update: batch.UpdateComputeEnvironmentRequest = {
            computeEnvironment: name,
          };
          let dirty = false;
          if ((ce.state ?? "ENABLED") !== desiredState) {
            update.state = desiredState;
            dirty = true;
          }
          if (desiredManagementType === "UNMANAGED") {
            if ((ce.unmanagedvCpus ?? 0) !== desiredUnmanagedvCpus) {
              update.unmanagedvCpus = desiredUnmanagedvCpus;
              dirty = true;
            }
          } else {
            const resources: batch.ComputeResourceUpdate = {};
            if ((ce.computeResources?.maxvCpus ?? 0) !== desiredMaxvCpus) {
              resources.maxvCpus = desiredMaxvCpus;
            }
            if (
              !sameSet(
                ce.computeResources?.subnets ?? [],
                desiredNetwork!.subnets,
              )
            ) {
              resources.subnets = desiredNetwork!.subnets;
            }
            if (
              !sameSet(
                ce.computeResources?.securityGroupIds ?? [],
                desiredNetwork!.securityGroupIds,
              )
            ) {
              resources.securityGroupIds = desiredNetwork!.securityGroupIds;
            }
            if (Object.keys(resources).length > 0) {
              update.computeResources = resources;
              dirty = true;
            }
          }
          if (dirty) {
            yield* retryBatch(
              batch.updateComputeEnvironment(update),
              (e) => e._tag === "ComputeEnvironmentBeingModified",
            );
            ce = yield* awaitValid();
          } else if (ce.status !== "VALID") {
            ce = yield* awaitValid();
          }

          // Sync tags — diff against OBSERVED cloud tags.
          const { upsert, removed } = diffTags(observedTagsOf(ce), desiredTags);
          if (upsert.length > 0) {
            yield* batch.tagResource({
              resourceArn: arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* batch.untagResource({ resourceArn: arn, tagKeys: removed });
          }

          yield* session.note(arn);
          return toAttributes(
            { ...ce, computeEnvironmentName: name, computeEnvironmentArn: arn },
            desiredTags,
          );
        }),
        delete: Effect.fn(function* ({ output, force }) {
          const name = output.computeEnvironmentName;
          const existing = yield* describeOne(name);
          if (!existing || existing.status === "DELETED") return;

          if (force === true) {
            yield* deleteRelatedJobQueues(name);
          }

          // Must be DISABLED before deletion.
          if (
            existing.status !== "DELETING" &&
            (existing.state ?? "ENABLED") !== "DISABLED"
          ) {
            yield* retryBatch(
              batch.updateComputeEnvironment({
                computeEnvironment: name,
                state: "DISABLED",
              }),
              (e) => e._tag === "ComputeEnvironmentBeingModified",
            ).pipe(
              Effect.catchTag("ComputeEnvironmentNotFound", () => Effect.void),
            );
          }
          const disabled = yield* awaitDisabled(name);
          if (!disabled || disabled.status === "DELETED") return;

          // deleteComputeEnvironment is idempotent (succeeds when missing) but
          // rejects while a JobQueue association is still tearing down — retry
          // through that window (queue deletion is asynchronous).
          if (disabled.status !== "DELETING") {
            yield* retryBatch(
              batch.deleteComputeEnvironment({ computeEnvironment: name }),
              (e) =>
                e._tag === "ComputeEnvironmentInUse" ||
                e._tag === "ComputeEnvironmentBeingModified",
              24,
            ).pipe(
              Effect.catchTag("ComputeEnvironmentNotFound", () => Effect.void),
            );
          }

          // Wait until it's actually gone (CE deletion takes ~1-2 minutes).
          yield* pollBatch(
            describeOne(name),
            (ce) => ce === undefined || ce.status === "DELETED",
          );
        }),
      };
    }),
  );
