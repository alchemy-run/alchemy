import * as Effect from "effect/Effect";

import type { ProviderService } from "../../provider.ts";
import {
  NetworkAclAssociation,
  type NetworkAclAssociationId,
} from "./network-acl-association.ts";
import type { NetworkAclId } from "./network-acl.ts";
import type { SubnetId } from "./subnet.ts";
import * as ec2 from "distilled-aws/ec2";

export const networkAclAssociationProvider = () =>
  NetworkAclAssociation.provider.effect(
    Effect.gen(function* () {
      const findAssociation = (subnetId: string) =>
        ec2
          .describeNetworkAcls({
            Filters: [{ Name: "association.subnet-id", Values: [subnetId] }],
          })
          .pipe(
            Effect.map((r) => {
              const acl = r.NetworkAcls?.[0];
              const assoc = acl?.Associations?.find(
                (a) => a.SubnetId === subnetId,
              );
              return assoc
                ? {
                    associationId: assoc.NetworkAclAssociationId!,
                    networkAclId: assoc.NetworkAclId!,
                    subnetId: assoc.SubnetId!,
                  }
                : undefined;
            }),
          );

      return {
        stables: ["subnetId"],

        read: Effect.fn(function* ({ olds }) {
          if (!olds) return undefined;
          const assoc = yield* findAssociation(olds.subnetId as string);
          if (!assoc) {
            return yield* Effect.fail(
              new Error(
                `Network ACL Association not found for subnet ${olds.subnetId}`,
              ),
            );
          }
          return {
            associationId: assoc.associationId as NetworkAclAssociationId,
            networkAclId: assoc.networkAclId as NetworkAclId,
            subnetId: assoc.subnetId as SubnetId,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // Subnet change requires replacement
          if (news.subnetId !== olds.subnetId) {
            return { action: "replace" };
          }
          // Network ACL change can be done via replaceNetworkAclAssociation
        }),

        create: Effect.fn(function* ({ news, session }) {
          yield* session.note(
            `Creating Network ACL Association for subnet ${news.subnetId}...`,
          );

          // First, find the current association for this subnet (every subnet has one)
          const currentAssoc = yield* findAssociation(news.subnetId as string);
          if (!currentAssoc) {
            return yield* Effect.fail(
              new Error(
                `No existing Network ACL Association found for subnet ${news.subnetId}`,
              ),
            );
          }

          // Replace the association with the new network ACL
          const result = yield* ec2.replaceNetworkAclAssociation({
            AssociationId: currentAssoc.associationId,
            NetworkAclId: news.networkAclId as string,
            DryRun: false,
          });

          const newAssociationId = result.NewAssociationId!;
          yield* session.note(
            `Network ACL Association created: ${newAssociationId}`,
          );

          return {
            associationId: newAssociationId as NetworkAclAssociationId,
            networkAclId: news.networkAclId as NetworkAclId,
            subnetId: news.subnetId as SubnetId,
          };
        }),

        update: Effect.fn(function* ({ news, output, session }) {
          yield* session.note(`Updating Network ACL Association...`);

          // Replace the association with the new network ACL
          const result = yield* ec2.replaceNetworkAclAssociation({
            AssociationId: output.associationId,
            NetworkAclId: news.networkAclId as string,
            DryRun: false,
          });

          const newAssociationId = result.NewAssociationId!;
          yield* session.note(
            `Network ACL Association updated: ${newAssociationId}`,
          );

          return {
            associationId: newAssociationId as NetworkAclAssociationId,
            networkAclId: news.networkAclId as NetworkAclId,
            subnetId: news.subnetId as SubnetId,
          };
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          yield* session.note(`Deleting Network ACL Association...`);

          // When deleting, we need to associate the subnet back to the default NACL
          // Find the default NACL for the VPC
          const subnetResult = yield* ec2.describeSubnets({
            SubnetIds: [olds.subnetId as string],
          });
          const vpcId = subnetResult.Subnets?.[0]?.VpcId;

          if (vpcId) {
            const defaultAclResult = yield* ec2.describeNetworkAcls({
              Filters: [
                { Name: "vpc-id", Values: [vpcId] },
                { Name: "default", Values: ["true"] },
              ],
            });

            const defaultAclId =
              defaultAclResult.NetworkAcls?.[0]?.NetworkAclId;

            if (
              defaultAclId &&
              defaultAclId !== (olds.networkAclId as string)
            ) {
              // Replace with default NACL
              yield* ec2
                .replaceNetworkAclAssociation({
                  AssociationId: output.associationId,
                  NetworkAclId: defaultAclId,
                  DryRun: false,
                })
                .pipe(
                  Effect.catchTag(
                    "InvalidAssociationID.NotFound",
                    () => Effect.void,
                  ),
                );

              yield* session.note(
                `Network ACL Association reverted to default`,
              );
            } else {
              yield* session.note(
                `Already using default Network ACL, nothing to do`,
              );
            }
          }
        }),
      } satisfies ProviderService<
        NetworkAclAssociation,
        any,
        any,
        any,
        any,
        any,
        any
      >;
    }),
  );
