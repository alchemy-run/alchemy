import * as ecs from "@distilled.cloud/aws/ecs";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { toMillis, toWireSeconds } from "../../Util/Duration.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { TargetGroupArn } from "../ELBv2/TargetGroup.ts";
import { waitForServiceConvergence } from "./Service.ts";

export interface ServiceTargetGroupAttachmentProps {
  /** ARN of the ECS cluster running the service. Changing it replaces the attachment. */
  cluster: string;
  /** Name of the ECS service to attach the target group to. Changing it replaces the attachment. */
  serviceName: string;
  /** ARN of the ELBv2 target group to attach. Changing it replaces the attachment. */
  targetGroupArn: string;
  /** Name of the container receiving traffic. Changing it replaces the attachment. */
  containerName: string;
  /** Container port receiving traffic. Changing it replaces the attachment. */
  containerPort: number;
  /**
   * ELB health-check grace period applied to the service when the target
   * group attaches, e.g. `"5 minutes"`. Keeps freshly-attached tasks alive
   * while the application behind them warms up (a node that serves nothing
   * until its first deployment lands).
   * @default "5 minutes"
   */
  healthCheckGracePeriod?: Duration.Input;
  /**
   * How long to wait for the attachment deployment (and target health) to
   * converge, capped at 90 seconds. The wait is best-effort: the
   * attachment is in place the moment `updateService` accepts it, so a
   * service whose tasks are still warming past the budget is noted and
   * the deploy continues — only a FAILED rollout (deployment circuit
   * breaker) fails the attachment. Consumers that need healthy targets
   * retry their first request. Skipped entirely when the service desires
   * zero tasks (there is nothing to register).
   * @default "90 seconds"
   */
  stabilizationTimeout?: Duration.Input;
}

export interface ServiceTargetGroupAttachment extends Resource<
  "AWS.ECS.ServiceTargetGroupAttachment",
  ServiceTargetGroupAttachmentProps,
  {
    /** ARN of the ECS cluster running the service. */
    cluster: string;
    /** Name of the attached ECS service. */
    serviceName: string;
    /** ARN of the attached target group. */
    targetGroupArn: string;
    /** Name of the container receiving traffic. */
    containerName: string;
    /** Container port receiving traffic. */
    containerPort: number;
  },
  never,
  Providers
> {}

/**
 * The attachment's ECS service does not exist (or is `INACTIVE`) in the
 * given cluster — the attachment requires the service to exist first.
 */
export class EcsServiceNotFound extends Data.TaggedError("EcsServiceNotFound")<{
  readonly cluster: string;
  readonly serviceName: string;
  readonly message: string;
}> {}

/**
 * Attaches an ELBv2 target group to an EXISTING ECS service via
 * `updateService` — the out-of-band counterpart of `AWS.ECS.Service`'s
 * composed `loadBalancer` prop, for ingress composed by a resource that is
 * not the service's own author (see `AWS.ECS.ServiceIngress`).
 *
 * The attachment merges its target group into the service's observed load
 * balancer list (never touching foreign entries), then waits — bounded —
 * for the resulting deployment, including target health, to converge.
 * Deleting the attachment removes exactly its own entry.
 *
 * ### Attaching a Target Group
 * **Example:** Expose an existing service through a composed ALB
 * ```typescript
 * const attachment = yield* ServiceTargetGroupAttachment("Ingress", {
 *   cluster: cluster.clusterArn,
 *   serviceName: service.serviceName,
 *   targetGroupArn: targetGroup.targetGroupArn,
 *   containerName: "app",
 *   containerPort: 8080,
 * });
 * ```
 *
 * @resource
 */
export const ServiceTargetGroupAttachment =
  Resource<ServiceTargetGroupAttachment>(
    "AWS.ECS.ServiceTargetGroupAttachment",
  );

/** Upper bound on the convergence wait (speed doctrine: never poll > 90s). */
const MAX_STABILIZATION_MILLIS = 90_000;

const stabilizationTimeout = (input: Duration.Input | undefined) =>
  Math.min(toMillis(input ?? "90 seconds")!, MAX_STABILIZATION_MILLIS);

/** The service rejects updates while transitioning; retry bounded. */
const retryWhileNotActive = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ServiceNotActiveException",
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(8)]),
  });

const describeService = (cluster: string, serviceName: string) =>
  ecs.describeServices({ cluster, services: [serviceName] }).pipe(
    Effect.map((described) =>
      described.services?.find(
        (service) =>
          service.serviceName === serviceName && service.status !== "INACTIVE",
      ),
    ),
    Effect.catchTag("ClusterNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

export const ServiceTargetGroupAttachmentProvider = () =>
  Provider.succeed(ServiceTargetGroupAttachment, {
    stables: [
      "cluster",
      "serviceName",
      "targetGroupArn",
      "containerName",
      "containerPort",
    ],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      // The attachment has no mutable aspect — identity changes replace.
      if (
        (olds.cluster !== undefined && olds.cluster !== news.cluster) ||
        (olds.serviceName !== undefined &&
          olds.serviceName !== news.serviceName) ||
        (olds.targetGroupArn !== undefined &&
          olds.targetGroupArn !== news.targetGroupArn) ||
        (olds.containerName !== undefined &&
          olds.containerName !== news.containerName) ||
        (olds.containerPort !== undefined &&
          olds.containerPort !== news.containerPort)
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ output }) {
      if (!output) return undefined;
      const service = yield* describeService(
        output.cluster,
        output.serviceName,
      );
      const attached = service?.loadBalancers?.some(
        (loadBalancer) => loadBalancer.targetGroupArn === output.targetGroupArn,
      );
      return attached ? output : undefined;
    }),

    list: () => Effect.succeed([]),

    reconcile: Effect.fn(function* ({ news, session }) {
      // Observe — the service is the only cloud state the attachment
      // touches; it must exist before anything can be attached to it.
      const service = yield* describeService(news.cluster, news.serviceName);
      if (service?.serviceArn === undefined) {
        return yield* Effect.fail(
          new EcsServiceNotFound({
            cluster: news.cluster,
            serviceName: news.serviceName,
            message:
              `ECS service '${news.serviceName}' was not found in cluster ` +
              `'${news.cluster}' — the attachment requires the service to exist.`,
          }),
        );
      }

      // Ensure — merge our entry into the observed load balancer list;
      // skip the API entirely when it is already there.
      const desired: ecs.LoadBalancer = {
        targetGroupArn: news.targetGroupArn as TargetGroupArn,
        containerName: news.containerName,
        containerPort: news.containerPort,
      };
      const observed = service.loadBalancers ?? [];
      const alreadyAttached = observed.some(
        (loadBalancer) =>
          loadBalancer.targetGroupArn === news.targetGroupArn &&
          loadBalancer.containerName === news.containerName &&
          loadBalancer.containerPort === news.containerPort,
      );

      if (!alreadyAttached) {
        yield* session.note(
          `Attaching ${news.targetGroupArn} to ${news.serviceName}`,
        );
        // Changing the load balancer set starts a new deployment on its
        // own — no `forceNewDeployment` needed (it would also force a
        // redundant roll on every re-attach).
        yield* retryWhileNotActive(
          ecs.updateService({
            cluster: news.cluster,
            service: news.serviceName,
            loadBalancers: [
              ...observed.filter(
                (loadBalancer) =>
                  loadBalancer.targetGroupArn !== news.targetGroupArn,
              ),
              desired,
            ],
            // Keep freshly-registered tasks alive while whatever serves
            // behind them warms up (see the prop doc).
            healthCheckGracePeriodSeconds: toWireSeconds(
              news.healthCheckGracePeriod ?? "5 minutes",
            ),
          }),
        );
      }

      // Wait — bounded, best-effort — for the attachment deployment
      // (including target health) to converge. The attachment is already
      // the desired cloud state; health is the service's and its
      // consumers' concern (they retry their first request), so the wait
      // never polls past 90s and only a FAILED rollout fails the resource.
      // With zero desired tasks there is nothing to register: ECS leaves
      // the zero-task deployment IN_PROGRESS until its next scheduler
      // sweep, so waiting would only burn the budget.
      if ((service.desiredCount ?? 0) === 0) {
        yield* session.note(
          `${news.serviceName} desires no tasks — nothing to wait for`,
        );
      } else {
        yield* session.note(
          `Waiting for ${news.serviceName} targets to become healthy`,
        );
        yield* waitForServiceConvergence({
          clusterArn: news.cluster,
          serviceName: news.serviceName,
          expectedTaskDefinitionArn: service.taskDefinition,
          mode: "stable",
          timeout: stabilizationTimeout(news.stabilizationTimeout),
        }).pipe(
          Effect.catchTag("ServiceDidNotStabilize", (error) =>
            Effect.gen(function* () {
              // Observe, don't guess: a rollout the circuit breaker failed
              // is a real failure; a rollout still in progress past the
              // budget is a slow warm-up, not a broken attachment.
              const observed = yield* describeService(
                news.cluster,
                news.serviceName,
              );
              const rolloutFailed = (observed?.deployments ?? []).some(
                (deployment) => deployment.rolloutState === "FAILED",
              );
              if (rolloutFailed) {
                return yield* Effect.fail(error);
              }
              yield* session.note(
                `${news.serviceName} targets not yet healthy after the ` +
                  "stabilization budget — continuing; consumers retry",
              );
            }),
          ),
        );
      }

      return {
        cluster: news.cluster,
        serviceName: news.serviceName,
        targetGroupArn: news.targetGroupArn,
        containerName: news.containerName,
        containerPort: news.containerPort,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const service = yield* describeService(
        output.cluster,
        output.serviceName,
      );
      if (service?.serviceArn === undefined) {
        // Service already gone (or being deleted with the stack) — nothing
        // to detach.
        return;
      }
      const remaining = (service.loadBalancers ?? []).filter(
        (loadBalancer) => loadBalancer.targetGroupArn !== output.targetGroupArn,
      );
      if (remaining.length === (service.loadBalancers ?? []).length) {
        return;
      }
      yield* retryWhileNotActive(
        ecs.updateService({
          cluster: output.cluster,
          service: output.serviceName,
          // An explicit empty list DETACHES; `undefined` means "leave
          // unchanged" on the wire.
          loadBalancers: remaining,
        }),
      ).pipe(
        Effect.catchTag(
          [
            "ServiceNotFoundException",
            "ServiceNotActiveException",
            "ClusterNotFoundException",
          ],
          () => Effect.void,
        ),
      );
      // Let the detach deployment settle briefly so the target group can be
      // deleted without ECS re-registering tasks into it; tolerate
      // non-convergence (the service itself may be mid-teardown).
      yield* waitForServiceConvergence({
        clusterArn: output.cluster,
        serviceName: output.serviceName,
        expectedTaskDefinitionArn: service.taskDefinition,
        mode: "stable",
        timeout: MAX_STABILIZATION_MILLIS,
      }).pipe(Effect.catch(() => Effect.void));
    }),
  });
