import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type TargetGroupName = string;
export type TargetGroupArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:targetgroup/${string}`;

export interface TargetGroupProps {
  /** The target group name. If omitted, a unique name is generated. Changing it replaces the target group. */
  name?: string;
  /** The VPC the targets live in. Not required for `lambda` targets. Changing it replaces the target group. */
  vpcId?: string;
  /** The port on which targets receive traffic. Changing it replaces the target group. */
  port?: number;
  /**
   * The protocol for routing traffic to targets. Changing it replaces the
   * target group.
   * @default "HTTP"
   */
  protocol?: "HTTP" | "HTTPS" | "TCP" | "UDP" | "TCP_UDP" | "TLS" | "GENEVE";
  /**
   * The application protocol version. Use `GRPC` for gRPC, `HTTP2` for HTTP/2.
   * Changing it replaces the target group.
   */
  protocolVersion?: "HTTP1" | "HTTP2" | "GRPC";
  /**
   * The target type. Changing it replaces the target group.
   * @default "ip"
   */
  targetType?: "ip" | "instance" | "lambda" | "alb";
  /** The IP address type (`ipv4`/`ipv6`). Changing it replaces the target group. */
  ipAddressType?: "ipv4" | "ipv6";
  /** The health-check path (HTTP/HTTPS). Updated in place. */
  healthCheckPath?: string;
  /** The health-check port. Updated in place. */
  healthCheckPort?: string;
  /** The health-check protocol. Updated in place. */
  healthCheckProtocol?: string;
  /** Whether health checks are enabled. Updated in place. */
  healthCheckEnabled?: boolean;
  /** The approximate interval between health checks, in seconds. Updated in place. */
  healthCheckIntervalSeconds?: number;
  /** The amount of time, in seconds, to wait for a health-check response. Updated in place. */
  healthCheckTimeoutSeconds?: number;
  /** The number of consecutive successes before a target is healthy. Updated in place. */
  healthyThresholdCount?: number;
  /** The number of consecutive failures before a target is unhealthy. Updated in place. */
  unhealthyThresholdCount?: number;
  /** The HTTP/gRPC codes used to determine a healthy response. Updated in place. */
  matcher?: { HttpCode?: string; GrpcCode?: string };
  /** Raw target-group attributes (deregistration delay, stickiness, slow start, ...). */
  attributes?: Record<string, string>;
  /** Tags to apply to the target group. */
  tags?: Record<string, string>;
}

export interface TargetGroup extends Resource<
  "AWS.ELBv2.TargetGroup",
  TargetGroupProps,
  {
    targetGroupArn: TargetGroupArn;
    targetGroupName: TargetGroupName;
    port: number;
    protocol: string;
    targetType: string;
    vpcId: string;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An ELBv2 target group. A target group routes requests to one or more
 * registered targets (instances, IPs, Lambda functions, or another ALB) using
 * the configured protocol and port, and runs health checks against them.
 * @resource
 * @section Creating a Target Group
 * @example HTTP target group
 * ```typescript
 * const tg = yield* TargetGroup("web", {
 *   vpcId: vpc.vpcId,
 *   port: 80,
 *   protocol: "HTTP",
 *   targetType: "ip",
 * });
 * ```
 *
 * @example gRPC target group
 * ```typescript
 * const tg = yield* TargetGroup("grpc", {
 *   vpcId: vpc.vpcId,
 *   port: 50051,
 *   protocol: "HTTP",
 *   protocolVersion: "GRPC",
 *   matcher: { GrpcCode: "0" },
 * });
 * ```
 *
 * @section Health Checks
 * @example Custom health-check thresholds
 * ```typescript
 * const tg = yield* TargetGroup("api", {
 *   vpcId: vpc.vpcId,
 *   port: 8080,
 *   protocol: "HTTP",
 *   healthCheckPath: "/healthz",
 *   healthCheckIntervalSeconds: 15,
 *   healthyThresholdCount: 3,
 *   unhealthyThresholdCount: 3,
 * });
 * ```
 */
export const TargetGroup = Resource<TargetGroup>("AWS.ELBv2.TargetGroup");

export const TargetGroupProvider = () =>
  Provider.effect(
    TargetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 32, lowercase: true });

      return {
        stables: ["targetGroupArn", "targetGroupName", "vpcId"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(
              {
                vpcId: olds.vpcId,
                protocol: olds.protocol ?? "HTTP",
                protocolVersion: olds.protocolVersion,
                port: olds.port,
                targetType: olds.targetType ?? "ip",
                ipAddressType: olds.ipAddressType,
              },
              {
                vpcId: news.vpcId,
                protocol: news.protocol ?? "HTTP",
                protocolVersion: news.protocolVersion,
                port: news.port,
                targetType: news.targetType ?? "ip",
                ipAddressType: news.ipAddressType,
              },
            )
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) {
            return undefined;
          }
          const described = yield* elbv2
            .describeTargetGroups({
              TargetGroupArns: [output.targetGroupArn],
            })
            .pipe(
              Effect.catchTag("TargetGroupNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const targetGroup = described?.TargetGroups?.[0];
          if (!targetGroup?.TargetGroupArn) {
            return undefined;
          }
          return {
            ...output,
            port: targetGroup.Port!,
            protocol: targetGroup.Protocol!,
            targetType: targetGroup.TargetType!,
            vpcId: targetGroup.VpcId!,
          };
        }),
        // Target groups are account/region-scoped. Exhaustively paginate
        // describeTargetGroups, then fetch tags per group (Attributes carry
        // them) to produce the same shape `read` returns.
        list: () =>
          Effect.gen(function* () {
            const targetGroups = yield* elbv2.describeTargetGroups
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) =>
                    (page.TargetGroups ?? []).filter(
                      (
                        tg,
                      ): tg is elbv2.TargetGroup & { TargetGroupArn: string } =>
                        tg.TargetGroupArn != null,
                    ),
                  ),
                ),
              );
            return yield* Effect.forEach(
              targetGroups,
              (tg) =>
                Effect.gen(function* () {
                  const tagDescriptions = yield* elbv2
                    .describeTags({ ResourceArns: [tg.TargetGroupArn] })
                    .pipe(
                      Effect.catchTag("TargetGroupNotFoundException", () =>
                        Effect.succeed(undefined),
                      ),
                    );
                  const tags = Object.fromEntries(
                    (tagDescriptions?.TagDescriptions?.[0]?.Tags ?? [])
                      .filter(
                        (t): t is { Key: string; Value: string } =>
                          typeof t.Key === "string" &&
                          typeof t.Value === "string",
                      )
                      .map((t) => [t.Key, t.Value]),
                  );
                  return {
                    targetGroupArn: tg.TargetGroupArn as TargetGroupArn,
                    targetGroupName: tg.TargetGroupName!,
                    port: tg.Port!,
                    protocol: tg.Protocol!,
                    targetType: tg.TargetType!,
                    vpcId: tg.VpcId!,
                    tags,
                  };
                }),
              { concurrency: 10 },
            );
          }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — look up by deterministic name.
          let described = yield* elbv2
            .describeTargetGroups({
              Names: [name],
            })
            .pipe(
              Effect.catchTag("TargetGroupNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          let targetGroup = described?.TargetGroups?.[0];

          // Ensure — create if missing. Stable axes (vpcId, port, protocol,
          // targetType) are handled by diff so we don't deal with mismatch.
          if (!targetGroup?.TargetGroupArn) {
            const created = yield* elbv2.createTargetGroup({
              Name: name,
              Port: news.port,
              Protocol: news.protocol ?? "HTTP",
              ProtocolVersion: news.protocolVersion,
              VpcId: news.vpcId,
              TargetType: news.targetType ?? "ip",
              IpAddressType: news.ipAddressType,
              HealthCheckPath: news.healthCheckPath,
              HealthCheckPort: news.healthCheckPort,
              HealthCheckProtocol: news.healthCheckProtocol,
              HealthCheckEnabled: news.healthCheckEnabled,
              HealthCheckIntervalSeconds: news.healthCheckIntervalSeconds,
              HealthCheckTimeoutSeconds: news.healthCheckTimeoutSeconds,
              HealthyThresholdCount: news.healthyThresholdCount,
              UnhealthyThresholdCount: news.unhealthyThresholdCount,
              Matcher: news.matcher,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            targetGroup = created.TargetGroups?.[0];
            if (!targetGroup?.TargetGroupArn) {
              return yield* Effect.die(
                new Error("createTargetGroup returned no target group"),
              );
            }
          }

          const targetGroupArn = targetGroup.TargetGroupArn as TargetGroupArn;

          // Sync health check — diff observed against desired; only call
          // modifyTargetGroup when a health-check field actually changed.
          const observedHc = {
            HealthCheckPath: targetGroup.HealthCheckPath,
            HealthCheckPort: targetGroup.HealthCheckPort,
            HealthCheckProtocol: targetGroup.HealthCheckProtocol,
            HealthCheckEnabled: targetGroup.HealthCheckEnabled,
            HealthCheckIntervalSeconds: targetGroup.HealthCheckIntervalSeconds,
            HealthCheckTimeoutSeconds: targetGroup.HealthCheckTimeoutSeconds,
            HealthyThresholdCount: targetGroup.HealthyThresholdCount,
            UnhealthyThresholdCount: targetGroup.UnhealthyThresholdCount,
            Matcher: targetGroup.Matcher,
          };
          const desiredHc = {
            HealthCheckPath: news.healthCheckPath ?? observedHc.HealthCheckPath,
            HealthCheckPort: news.healthCheckPort ?? observedHc.HealthCheckPort,
            HealthCheckProtocol:
              news.healthCheckProtocol ?? observedHc.HealthCheckProtocol,
            HealthCheckEnabled:
              news.healthCheckEnabled ?? observedHc.HealthCheckEnabled,
            HealthCheckIntervalSeconds:
              news.healthCheckIntervalSeconds ??
              observedHc.HealthCheckIntervalSeconds,
            HealthCheckTimeoutSeconds:
              news.healthCheckTimeoutSeconds ??
              observedHc.HealthCheckTimeoutSeconds,
            HealthyThresholdCount:
              news.healthyThresholdCount ?? observedHc.HealthyThresholdCount,
            UnhealthyThresholdCount:
              news.unhealthyThresholdCount ??
              observedHc.UnhealthyThresholdCount,
            Matcher: news.matcher ?? observedHc.Matcher,
          };
          if (!deepEqual(observedHc, desiredHc)) {
            yield* elbv2.modifyTargetGroup({
              TargetGroupArn: targetGroupArn,
              ...desiredHc,
            });
          }

          // Sync attributes — observed ↔ desired. Always apply when desired
          // attrs are non-empty.
          if (news.attributes && Object.keys(news.attributes).length > 0) {
            yield* elbv2.modifyTargetGroupAttributes({
              TargetGroupArn: targetGroupArn,
              Attributes: Object.entries(news.attributes).map(
                ([Key, Value]) => ({
                  Key,
                  Value,
                }),
              ),
            });
          }

          // Sync tags — diff observed cloud tags against desired.
          const tagDescriptions = yield* elbv2.describeTags({
            ResourceArns: [targetGroupArn],
          });
          const observedTags = Object.fromEntries(
            (tagDescriptions.TagDescriptions?.[0]?.Tags ?? [])
              .filter(
                (t): t is { Key: string; Value: string } =>
                  typeof t.Key === "string" && typeof t.Value === "string",
              )
              .map((t) => [t.Key, t.Value]),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* elbv2.addTags({
              ResourceArns: [targetGroupArn],
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* elbv2.removeTags({
              ResourceArns: [targetGroupArn],
              TagKeys: removed,
            });
          }

          yield* session.note(targetGroupArn);
          return {
            targetGroupArn,
            targetGroupName: targetGroup.TargetGroupName!,
            port: targetGroup.Port!,
            protocol: targetGroup.Protocol!,
            targetType: targetGroup.TargetType!,
            vpcId: targetGroup.VpcId!,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // deleteTargetGroup is idempotent on a missing target group (returns
          // success). It only fails with ResourceInUseException while a
          // listener/rule still references it — retry briefly for the
          // eventual-consistency window after the dependents are removed.
          yield* elbv2
            .deleteTargetGroup({
              TargetGroupArn: output.targetGroupArn,
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "ResourceInUseException",
                schedule: Schedule.spaced("3 seconds").pipe(
                  Schedule.both(Schedule.recurs(8)),
                ),
              }),
              Effect.catchTag("ResourceInUseException", () => Effect.void),
            );
        }),
      };
    }),
  );
