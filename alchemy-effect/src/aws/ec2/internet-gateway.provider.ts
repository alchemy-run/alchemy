import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import * as ec2 from "distilled-aws/ec2";

import type { ScopedPlanStatusSession } from "../../cli/service.ts";
import { createInternalTags, createTagsList } from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "distilled-aws/Region";
import {
  InternetGateway,
  type InternetGatewayAttrs,
  type InternetGatewayId,
  type InternetGatewayProps,
} from "./internet-gateway.ts";

export const internetGatewayProvider = () =>
  InternetGateway.provider.effect(
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      return {
        stables: ["internetGatewayId", "internetGatewayArn", "ownerId"],

        create: Effect.fn(function* ({ id, news, session }) {
          // 1. Prepare tags
          const alchemyTags = yield* createInternalTags(id);
          const userTags = news.tags ?? {};
          const allTags = { ...alchemyTags, ...userTags };

          // 2. Call CreateInternetGateway
          const createResult = yield* ec2.createInternetGateway({
            TagSpecifications: [
              {
                ResourceType: "internet-gateway",
                Tags: createTagsList(allTags),
              },
            ],
            DryRun: false,
          });

          const internetGatewayId = createResult.InternetGateway!
            .InternetGatewayId! as InternetGatewayId;
          yield* session.note(`Internet gateway created: ${internetGatewayId}`);

          // 3. Attach to VPC if specified
          if (news.vpcId) {
            yield* ec2
              .attachInternetGateway({
                InternetGatewayId: internetGatewayId,
                VpcId: news.vpcId,
              })
              .pipe(
                Effect.retry({
                  // Retry if VPC is not yet available
                  while: (e) => e._tag === "InvalidVpcID.NotFound",
                  schedule: Schedule.exponential(100),
                }),
              );
            yield* session.note(`Attached to VPC: ${news.vpcId}`);
          }

          // 4. Describe to get full details
          const igw = yield* describeInternetGateway(
            internetGatewayId,
            session,
          );

          // 5. Return attributes
          return {
            internetGatewayId,
            internetGatewayArn:
              `arn:aws:ec2:${region}:${accountId}:internet-gateway/${internetGatewayId}` as InternetGatewayAttrs<InternetGatewayProps>["internetGatewayArn"],
            vpcId: news.vpcId,
            ownerId: igw.OwnerId,
            attachments: igw.Attachments?.map((a) => ({
              state: a.State! as
                | "attaching"
                | "available"
                | "detaching"
                | "detached",
              vpcId: a.VpcId!,
            })),
          } satisfies InternetGatewayAttrs<InternetGatewayProps>;
        }),

        update: Effect.fn(function* ({ news, olds, output, session }) {
          const internetGatewayId = output.internetGatewayId;

          // Handle VPC attachment changes
          if (news.vpcId !== olds.vpcId) {
            // Detach from old VPC if was attached
            if (olds.vpcId) {
              yield* ec2
                .detachInternetGateway({
                  InternetGatewayId: internetGatewayId,
                  VpcId: olds.vpcId,
                })
                .pipe(
                  Effect.catchTag("Gateway.NotAttached", () => Effect.void),
                );
              yield* session.note(`Detached from VPC: ${olds.vpcId}`);
            }

            // Attach to new VPC if specified
            if (news.vpcId) {
              yield* ec2
                .attachInternetGateway({
                  InternetGatewayId: internetGatewayId,
                  VpcId: news.vpcId,
                })
                .pipe(
                  Effect.retry({
                    while: (e) => e._tag === "InvalidVpcID.NotFound",
                    schedule: Schedule.exponential(100),
                  }),
                );
              yield* session.note(`Attached to VPC: ${news.vpcId}`);
            }
          }

          // Handle tag updates
          if (
            JSON.stringify(news.tags ?? {}) !== JSON.stringify(olds.tags ?? {})
          ) {
            const alchemyTags = yield* createInternalTags(
              output.internetGatewayId,
            );
            const userTags = news.tags ?? {};
            const allTags = { ...alchemyTags, ...userTags };

            // Delete old tags that are no longer present
            const oldTagKeys = Object.keys(olds.tags ?? {});
            const newTagKeys = Object.keys(news.tags ?? {});
            const tagsToDelete = oldTagKeys.filter(
              (key) => !newTagKeys.includes(key),
            );

            if (tagsToDelete.length > 0) {
              yield* ec2.deleteTags({
                Resources: [internetGatewayId],
                Tags: tagsToDelete.map((key) => ({ Key: key })),
              });
            }

            // Create/update tags
            yield* ec2.createTags({
              Resources: [internetGatewayId],
              Tags: createTagsList(allTags),
            });

            yield* session.note("Updated tags");
          }

          // Re-describe to get current state
          const igw = yield* describeInternetGateway(
            internetGatewayId,
            session,
          );

          return {
            ...output,
            vpcId: news.vpcId,
            attachments: igw.Attachments?.map((a) => ({
              state: a.State! as
                | "attaching"
                | "available"
                | "detaching"
                | "detached",
              vpcId: a.VpcId!,
            })),
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const internetGatewayId = output.internetGatewayId;

          yield* session.note(
            `Deleting internet gateway: ${internetGatewayId}`,
          );

          // 1. Detach from all VPCs first
          if (output.attachments && output.attachments.length > 0) {
            for (const attachment of output.attachments) {
              yield* ec2
                .detachInternetGateway({
                  InternetGatewayId: internetGatewayId,
                  VpcId: attachment.vpcId,
                })
                .pipe(
                  Effect.tapError(Effect.logDebug),
                  Effect.catchTag("Gateway.NotAttached", () => Effect.void),
                  Effect.catchTag(
                    "InvalidInternetGatewayID.NotFound",
                    () => Effect.void,
                  ),
                  // Retry on dependency violations (e.g., NAT Gateway with EIP still attached)
                  Effect.retry({
                    while: (e) => {
                      return e._tag === "DependencyViolation";
                    },
                    schedule: Schedule.exponential(1000, 1.5).pipe(
                      Schedule.intersect(Schedule.recurs(20)), // Up to 20 retries
                      Schedule.tapOutput(([, attempt]) =>
                        session.note(
                          `Waiting for VPC dependencies to clear before detaching... (attempt ${attempt + 1})`,
                        ),
                      ),
                    ),
                  }),
                );
              yield* session.note(`Detached from VPC: ${attachment.vpcId}`);
            }
          }

          // 2. Delete the internet gateway
          yield* ec2
            .deleteInternetGateway({
              InternetGatewayId: internetGatewayId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag(
                "InvalidInternetGatewayID.NotFound",
                () => Effect.void,
              ),
              // Retry on dependency violations
              Effect.retry({
                while: (e) => {
                  return (
                    e._tag === "DependencyViolation" ||
                    (e._tag === "ValidationError" &&
                      e.message?.includes("DependencyViolation"))
                  );
                },
                schedule: Schedule.exponential(1000, 1.5).pipe(
                  Schedule.intersect(Schedule.recurs(10)),
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          // 3. Wait for internet gateway to be fully deleted
          yield* waitForInternetGatewayDeleted(internetGatewayId, session);

          yield* session.note(
            `Internet gateway ${internetGatewayId} deleted successfully`,
          );
        }),
      };
    }),
  );

/**
 * Describe an internet gateway by ID
 */
const describeInternetGateway = (
  internetGatewayId: string,
  _session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeInternetGateways({ InternetGatewayIds: [internetGatewayId] })
      .pipe(
        Effect.catchTag("InvalidInternetGatewayID.NotFound", () =>
          Effect.succeed({ InternetGateways: [] }),
        ),
      );

    const igw = result.InternetGateways?.[0];
    if (!igw) {
      return yield* Effect.fail(new Error("Internet gateway not found"));
    }
    return igw;
  });

/**
 * Wait for internet gateway to be deleted
 */
const waitForInternetGatewayDeleted = (
  internetGatewayId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    yield* Effect.retry(
      Effect.gen(function* () {
        const result = yield* ec2
          .describeInternetGateways({ InternetGatewayIds: [internetGatewayId] })
          .pipe(
            Effect.tapError(Effect.logDebug),
            Effect.catchTag("InvalidInternetGatewayID.NotFound", () =>
              Effect.succeed({ InternetGateways: [] }),
            ),
          );

        if (!result.InternetGateways || result.InternetGateways.length === 0) {
          return; // Successfully deleted
        }

        // Still exists, fail to trigger retry
        return yield* Effect.fail(new Error("Internet gateway still exists"));
      }),
      {
        schedule: Schedule.fixed(2000).pipe(
          Schedule.intersect(Schedule.recurs(15)),
          Schedule.tapOutput(([, attempt]) =>
            session.note(
              `Waiting for internet gateway deletion... (${(attempt + 1) * 2}s)`,
            ),
          ),
        ),
      },
    );
  });
