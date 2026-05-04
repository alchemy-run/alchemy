import { Region } from "@distilled.cloud/aws/Region";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, tagRecord } from "../../Tags.ts";

import { syncTags, vpcLinkArn } from "./common.ts";

export interface VpcLinkProps {
  /**
   * Name of the VPC link.
   *
   * If omitted, Alchemy generates a deterministic physical name.
   */
  name?: string;
  /**
   * Target ARNs for the integration (e.g. load balancer ARNs).
   */
  targetArns: string[];
  description?: string;
  tags?: Record<string, string>;
}

export interface VpcLink extends Resource<
  "AWS.ApiGateway.VpcLink",
  VpcLinkProps,
  {
    vpcLinkId: string;
    name: string | undefined;
    description: string | undefined;
    targetArns: string[] | undefined;
    status: ag.VpcLinkStatus | undefined;
    statusMessage: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * VPC link for private integrations (`connectionType: "VPC_LINK"` on a method integration).
 *
 * @section Private integrations
 * @example Create a VPC link
 * ```typescript
 * const link = yield* ApiGateway.VpcLink("NlbLink", {
 *   description: "Link to internal NLB",
 *   targetArns: [nlb.loadBalancerArn],
 * });
 *
 * yield* ApiGateway.Method("PrivateGet", {
 *   restApiId: api.restApiId,
 *   resourceId: resource.resourceId,
 *   httpMethod: "GET",
 *   integration: {
 *     type: "HTTP_PROXY",
 *     integrationHttpMethod: "GET",
 *     uri: "https://api.internal.example.com/hello",
 *     connectionType: "VPC_LINK",
 *     connectionId: link.vpcLinkId,
 *   },
 * });
 * ```
 */
const VpcLinkResource = Resource<VpcLink>("AWS.ApiGateway.VpcLink");

export { VpcLinkResource as VpcLink };

const generatedName = (id: string, props: VpcLinkProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 128,
      });

const snapshotFromVpcLink = (
  v: ag.VpcLink,
  tags: Record<string, string>,
): VpcLink["Attributes"] => ({
  vpcLinkId: v.id!,
  name: v.name,
  description: v.description,
  targetArns: v.targetArns,
  status: v.status,
  statusMessage: v.statusMessage,
  tags,
});

export const VpcLinkProvider = () =>
  Provider.effect(
    VpcLinkResource,
    Effect.gen(function* () {
      const awsRegion = yield* Region;

      return {
        stables: ["vpcLinkId"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as VpcLinkProps;
          if (!deepEqual(news.targetArns, olds.targetArns)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.vpcLinkId) return undefined;
          const v = yield* ag
            .getVpcLink({ vpcLinkId: output.vpcLinkId })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!v?.id) return undefined;
          return snapshotFromVpcLink(v, tagRecord(v.tags));
        }),
        create: Effect.fn(function* ({ id, news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("VpcLink props were not resolved");
          }
          const news = newsIn as VpcLinkProps;
          const name = yield* generatedName(id, news);
          const internalTags = yield* createInternalTags(id);
          const allTags = { ...news.tags, ...internalTags };

          const created = yield* ag.createVpcLink({
            name,
            description: news.description,
            targetArns: news.targetArns,
            tags: allTags,
          });
          if (!created.id) {
            return yield* Effect.die("createVpcLink missing id");
          }
          yield* session.note(`Created VPC link ${created.id}`);

          const v = yield* ag.getVpcLink({ vpcLinkId: created.id });
          if (!v.id) return yield* Effect.die("getVpcLink missing id");
          return snapshotFromVpcLink(v, tagRecord(v.tags));
        }),
        update: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("VpcLink props were not resolved");
          }
          const news = newsIn as VpcLinkProps;
          const patches: ag.PatchOperation[] = [];
          if (news.description !== output.description) {
            patches.push({
              op: "replace",
              path: "/description",
              value: news.description ?? "",
            });
          }
          if (news.name !== undefined && news.name !== output.name) {
            patches.push({
              op: "replace",
              path: "/name",
              value: news.name,
            });
          }
          if (patches.length > 0) {
            yield* ag.updateVpcLink({
              vpcLinkId: output.vpcLinkId,
              patchOperations: patches,
            });
          }

          const internalTags = yield* createInternalTags(id);
          const newTags = { ...news.tags, ...internalTags };
          if (!deepEqual(output.tags, newTags)) {
            yield* syncTags({
              resourceArn: vpcLinkArn(awsRegion, output.vpcLinkId),
              oldTags: output.tags,
              newTags,
            });
          }

          yield* session.note(`Updated VPC link ${output.vpcLinkId}`);
          const v = yield* ag.getVpcLink({ vpcLinkId: output.vpcLinkId });
          return snapshotFromVpcLink(v, tagRecord(v.tags));
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag.deleteVpcLink({ vpcLinkId: output.vpcLinkId }).pipe(
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
            Effect.catchTag("NotFoundException", () => Effect.void),
          );
          yield* session.note(`Deleted VPC link ${output.vpcLinkId}`);
        }),
      };
    }),
  );
