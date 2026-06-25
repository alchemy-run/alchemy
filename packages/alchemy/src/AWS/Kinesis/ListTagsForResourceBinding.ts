import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListTagsForResource,
  type ListTagsForResourceRequest,
  type TaggableResource,
} from "./ListTagsForResource.ts";

const getResourceArn = (resource: TaggableResource) =>
  "consumerArn" in resource ? resource.consumerArn : resource.streamArn;

export const ListTagsForResourceBinding = Layer.effect(
  ListTagsForResource,
  Effect.gen(function* () {
    const listTagsForResource = yield* Kinesis.listTagsForResource;

    return Effect.fn(function* (resource: TaggableResource) {
      const ResourceARN = yield* getResourceArn(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.ListTagsForResource(${resource}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["kinesis:ListTagsForResource"],
                  Resource: [getResourceArn(resource)],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(function* (request?: ListTagsForResourceRequest) {
        return yield* listTagsForResource({
          ...request,
          ResourceARN: yield* ResourceARN,
        });
      });
    });
  }),
);
