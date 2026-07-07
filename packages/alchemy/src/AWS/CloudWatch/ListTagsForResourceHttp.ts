import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  getTaggableResourceArn,
  type TaggableResource,
} from "./binding-common.ts";
import {
  ListTagsForResource,
  type ListTagsForResourceRequest,
} from "./ListTagsForResource.ts";

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  Effect.gen(function* () {
    const listTagsForResource = yield* cloudwatch.listTagsForResource;

    return Effect.fn(function* (resource: TaggableResource) {
      const ResourceARN = yield* getTaggableResourceArn(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.ListTagsForResource(${resource}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:ListTagsForResource"],
                  Resource: [getTaggableResourceArn(resource)],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.CloudWatch.ListTagsForResource(${resource.LogicalId})`,
      )(function* (request: ListTagsForResourceRequest = {}) {
        return yield* listTagsForResource({
          ...request,
          ResourceARN: yield* ResourceARN,
        });
      });
    });
  }),
);
