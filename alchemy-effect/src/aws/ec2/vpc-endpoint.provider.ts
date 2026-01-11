import * as ec2 from "distilled-aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type { ScopedPlanStatusSession } from "../../cli/service.ts";
import { createInternalTags, createTagsList, diffTags } from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "distilled-aws/Region";
import {
  VpcEndpoint,
  type VpcEndpointAttrs,
  type VpcEndpointId,
  type VpcEndpointProps,
} from "./vpc-endpoint.ts";

export const vpcEndpointProvider = () =>
  VpcEndpoint.provider.effect(
    // @ts-expect-error - TODO: fix this
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          Name: id,
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const describeVpcEndpoint = (vpcEndpointId: string) =>
        ec2.describeVpcEndpoints({ VpcEndpointIds: [vpcEndpointId] }).pipe(
          Effect.map((r) => r.VpcEndpoints?.[0]),
          Effect.flatMap((ep) =>
            ep
              ? Effect.succeed(ep)
              : Effect.fail(
                  new Error(`VPC Endpoint ${vpcEndpointId} not found`),
                ),
          ),
        );

      const toAttrs = (
        ep: ec2.VpcEndpoint,
      ): VpcEndpointAttrs<VpcEndpointProps> => ({
        vpcEndpointId: ep.VpcEndpointId as VpcEndpointId,
        vpcEndpointArn:
          `arn:aws:ec2:${region}:${accountId}:vpc-endpoint/${ep.VpcEndpointId}` as VpcEndpointAttrs<VpcEndpointProps>["vpcEndpointArn"],
        vpcEndpointType: ep.VpcEndpointType!,
        vpcId: ep.VpcId as VpcEndpointAttrs<VpcEndpointProps>["vpcId"],
        serviceName:
          ep.ServiceName as VpcEndpointAttrs<VpcEndpointProps>["serviceName"],
        state: ep.State!,
        policyDocument: ep.PolicyDocument,
        routeTableIds: ep.RouteTableIds,
        subnetIds: ep.SubnetIds,
        groups: ep.Groups?.map((g) => ({
          groupId: g.GroupId!,
          groupName: g.GroupName!,
        })),
        privateDnsEnabled: ep.PrivateDnsEnabled,
        requesterManaged: ep.RequesterManaged,
        networkInterfaceIds: ep.NetworkInterfaceIds,
        dnsEntries: ep.DnsEntries?.map((d) => ({
          dnsName: d.DnsName,
          hostedZoneId: d.HostedZoneId,
        })),
        creationTimestamp:
          ep.CreationTimestamp instanceof Date
            ? ep.CreationTimestamp.toISOString()
            : (ep.CreationTimestamp as string | undefined),
        ownerId: ep.OwnerId,
        ipAddressType: ep.IpAddressType,
        dnsOptions: ep.DnsOptions
          ? {
              dnsRecordIpType: ep.DnsOptions.DnsRecordIpType,
              privateDnsOnlyForInboundResolverEndpoint:
                ep.DnsOptions.PrivateDnsOnlyForInboundResolverEndpoint,
            }
          : undefined,
        lastError: ep.LastError
          ? {
              code: ep.LastError.Code,
              message: ep.LastError.Message,
            }
          : undefined,
      });

      return {
        stables: ["vpcEndpointId", "vpcEndpointArn", "ownerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const ep = yield* describeVpcEndpoint(output.vpcEndpointId);
          return toAttrs(ep);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // Core properties require replacement
          if (
            news.vpcId !== olds.vpcId ||
            news.serviceName !== olds.serviceName ||
            news.vpcEndpointType !== olds.vpcEndpointType
          ) {
            return { action: "replace" };
          }
          // Other properties can be updated in-place
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          yield* session.note(
            `Creating VPC Endpoint for ${news.serviceName}...`,
          );

          const result = yield* ec2.createVpcEndpoint({
            VpcId: news.vpcId as string,
            ServiceName: news.serviceName,
            VpcEndpointType: news.vpcEndpointType ?? "Gateway",
            RouteTableIds: news.routeTableIds as string[] | undefined,
            SubnetIds: news.subnetIds as string[] | undefined,
            SecurityGroupIds: news.securityGroupIds as string[] | undefined,
            PrivateDnsEnabled: news.privateDnsEnabled,
            PolicyDocument: news.policyDocument,
            IpAddressType: news.ipAddressType,
            DnsOptions: news.dnsOptions
              ? {
                  DnsRecordIpType: news.dnsOptions.dnsRecordIpType,
                  PrivateDnsOnlyForInboundResolverEndpoint:
                    news.dnsOptions.privateDnsOnlyForInboundResolverEndpoint,
                }
              : undefined,
            TagSpecifications: [
              {
                ResourceType: "vpc-endpoint",
                Tags: createTagsList(yield* createTags(id, news.tags)),
              },
            ],
            DryRun: false,
          });

          const vpcEndpointId = result.VpcEndpoint!.VpcEndpointId!;
          yield* session.note(`VPC Endpoint created: ${vpcEndpointId}`);

          // Wait for endpoint to be available (for Interface endpoints)
          if (
            news.vpcEndpointType === "Interface" ||
            news.vpcEndpointType === "GatewayLoadBalancer"
          ) {
            yield* waitForVpcEndpointAvailable(vpcEndpointId, session);
          }

          const ep = yield* describeVpcEndpoint(vpcEndpointId);
          return toAttrs(ep);
        }),

        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const vpcEndpointId = output.vpcEndpointId;

          // Modify endpoint if needed
          const modifications: Parameters<typeof ec2.modifyVpcEndpoint>[0] = {
            VpcEndpointId: vpcEndpointId,
            DryRun: false,
          };

          let hasModifications = false;

          // Handle route table changes (for Gateway endpoints)
          if (news.vpcEndpointType === "Gateway" || !news.vpcEndpointType) {
            const oldRouteTableIds = new Set(olds.routeTableIds ?? []);
            const newRouteTableIds = new Set(news.routeTableIds ?? []);

            const addRouteTableIds = [...newRouteTableIds].filter(
              (id) => !oldRouteTableIds.has(id),
            );
            const removeRouteTableIds = [...oldRouteTableIds].filter(
              (id) => !newRouteTableIds.has(id),
            );

            if (addRouteTableIds.length > 0) {
              modifications.AddRouteTableIds = addRouteTableIds as string[];
              hasModifications = true;
            }
            if (removeRouteTableIds.length > 0) {
              modifications.RemoveRouteTableIds =
                removeRouteTableIds as string[];
              hasModifications = true;
            }
          }

          // Handle subnet changes (for Interface endpoints)
          if (
            news.vpcEndpointType === "Interface" ||
            news.vpcEndpointType === "GatewayLoadBalancer"
          ) {
            const oldSubnetIds = new Set(olds.subnetIds ?? []);
            const newSubnetIds = new Set(news.subnetIds ?? []);

            const addSubnetIds = [...newSubnetIds].filter(
              (id) => !oldSubnetIds.has(id),
            );
            const removeSubnetIds = [...oldSubnetIds].filter(
              (id) => !newSubnetIds.has(id),
            );

            if (addSubnetIds.length > 0) {
              modifications.AddSubnetIds = addSubnetIds as string[];
              hasModifications = true;
            }
            if (removeSubnetIds.length > 0) {
              modifications.RemoveSubnetIds = removeSubnetIds as string[];
              hasModifications = true;
            }

            // Handle security group changes
            const oldSecurityGroupIds = new Set(olds.securityGroupIds ?? []);
            const newSecurityGroupIds = new Set(news.securityGroupIds ?? []);

            const addSecurityGroupIds = [...newSecurityGroupIds].filter(
              (id) => !oldSecurityGroupIds.has(id),
            );
            const removeSecurityGroupIds = [...oldSecurityGroupIds].filter(
              (id) => !newSecurityGroupIds.has(id),
            );

            if (addSecurityGroupIds.length > 0) {
              modifications.AddSecurityGroupIds =
                addSecurityGroupIds as string[];
              hasModifications = true;
            }
            if (removeSecurityGroupIds.length > 0) {
              modifications.RemoveSecurityGroupIds =
                removeSecurityGroupIds as string[];
              hasModifications = true;
            }

            // Handle private DNS change
            if (news.privateDnsEnabled !== olds.privateDnsEnabled) {
              modifications.PrivateDnsEnabled = news.privateDnsEnabled;
              hasModifications = true;
            }
          }

          // Handle policy document change
          if (news.policyDocument !== olds.policyDocument) {
            modifications.PolicyDocument = news.policyDocument ?? "";
            modifications.ResetPolicy = !news.policyDocument;
            hasModifications = true;
          }

          // Handle IP address type change
          if (news.ipAddressType !== olds.ipAddressType) {
            modifications.IpAddressType = news.ipAddressType;
            hasModifications = true;
          }

          // Handle DNS options change
          if (
            news.dnsOptions?.dnsRecordIpType !==
              olds.dnsOptions?.dnsRecordIpType ||
            news.dnsOptions?.privateDnsOnlyForInboundResolverEndpoint !==
              olds.dnsOptions?.privateDnsOnlyForInboundResolverEndpoint
          ) {
            modifications.DnsOptions = news.dnsOptions
              ? {
                  DnsRecordIpType: news.dnsOptions.dnsRecordIpType,
                  PrivateDnsOnlyForInboundResolverEndpoint:
                    news.dnsOptions.privateDnsOnlyForInboundResolverEndpoint,
                }
              : undefined;
            hasModifications = true;
          }

          if (hasModifications) {
            yield* ec2.modifyVpcEndpoint(modifications);
            yield* session.note("Updated VPC Endpoint configuration");
          }

          // Handle tag updates
          const newTags = yield* createTags(id, news.tags);
          const oldTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [vpcEndpointId] },
                  { Name: "resource-type", Values: ["vpc-endpoint"] },
                ],
              })
              .pipe(
                Effect.map(
                  (r) =>
                    Object.fromEntries(
                      r.Tags?.map((t) => [t.Key!, t.Value!]) ?? [],
                    ) as Record<string, string>,
                ),
              )) ?? {};

          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [vpcEndpointId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [vpcEndpointId],
              Tags: upsert,
              DryRun: false,
            });
            yield* session.note("Updated tags");
          }

          // Wait for endpoint to be available if we made modifications
          if (
            hasModifications &&
            (news.vpcEndpointType === "Interface" ||
              news.vpcEndpointType === "GatewayLoadBalancer")
          ) {
            yield* waitForVpcEndpointAvailable(vpcEndpointId, session);
          }

          const ep = yield* describeVpcEndpoint(vpcEndpointId);
          return toAttrs(ep);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const vpcEndpointId = output.vpcEndpointId;

          yield* session.note(`Deleting VPC Endpoint: ${vpcEndpointId}`);

          yield* ec2
            .deleteVpcEndpoints({
              VpcEndpointIds: [vpcEndpointId],
              DryRun: false,
            })
            .pipe(
              Effect.catchTag(
                "InvalidVpcEndpointId.NotFound",
                () => Effect.void,
              ),
            );

          // Wait for deletion
          yield* waitForVpcEndpointDeleted(vpcEndpointId, session);

          yield* session.note(`VPC Endpoint ${vpcEndpointId} deleted`);
        }),
      };
    }),
  );

// Retryable error: VPC Endpoint is still pending
class VpcEndpointPending extends Data.TaggedError("VpcEndpointPending")<{
  vpcEndpointId: string;
  state: string;
}> {}

// Terminal error: VPC Endpoint creation failed
class VpcEndpointFailed extends Data.TaggedError("VpcEndpointFailed")<{
  vpcEndpointId: string;
  errorCode?: string;
  errorMessage?: string;
}> {}

// Terminal error: VPC Endpoint not found
class VpcEndpointNotFound extends Data.TaggedError("VpcEndpointNotFound")<{
  vpcEndpointId: string;
}> {}

// Retryable error: VPC Endpoint is still deleting
class VpcEndpointDeleting extends Data.TaggedError("VpcEndpointDeleting")<{
  vpcEndpointId: string;
  state: string;
}> {}

/**
 * Wait for VPC Endpoint to be in available state
 */
const waitForVpcEndpointAvailable = (
  vpcEndpointId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2.describeVpcEndpoints({
      VpcEndpointIds: [vpcEndpointId],
    });
    const ep = result.VpcEndpoints?.[0];

    if (!ep) {
      return yield* new VpcEndpointNotFound({ vpcEndpointId });
    }

    if (ep.State === "Available") {
      return ep;
    }

    if (ep.State === "Failed" || ep.State === "Rejected") {
      return yield* new VpcEndpointFailed({
        vpcEndpointId,
        errorCode: ep.LastError?.Code,
        errorMessage: ep.LastError?.Message,
      });
    }

    // Still pending - this is the only retryable case
    return yield* new VpcEndpointPending({ vpcEndpointId, state: ep.State! });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "VpcEndpointPending",
      schedule: Schedule.fixed(3000).pipe(
        Schedule.intersect(Schedule.recurs(60)), // Max 3 minutes
        Schedule.tapOutput(([, attempt]) =>
          session.note(
            `Waiting for VPC Endpoint to be available... (${(attempt + 1) * 3}s)`,
          ),
        ),
      ),
    }),
  );

/**
 * Wait for VPC Endpoint to be deleted
 */
const waitForVpcEndpointDeleted = (
  vpcEndpointId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeVpcEndpoints({ VpcEndpointIds: [vpcEndpointId] })
      .pipe(
        Effect.catchTag("InvalidVpcEndpointId.NotFound", () =>
          Effect.succeed({ VpcEndpoints: [] }),
        ),
      );

    const ep = result.VpcEndpoints?.[0];

    if (!ep || ep.State === "Deleted") {
      return; // Successfully deleted
    }

    // Still deleting - this is the only retryable case
    return yield* new VpcEndpointDeleting({ vpcEndpointId, state: ep.State! });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "VpcEndpointDeleting",
      schedule: Schedule.fixed(3000).pipe(
        Schedule.intersect(Schedule.recurs(60)), // Max 3 minutes
        Schedule.tapOutput(([, attempt]) =>
          session.note(
            `Waiting for VPC Endpoint deletion... (${(attempt + 1) * 3}s)`,
          ),
        ),
      ),
    }),
  );
