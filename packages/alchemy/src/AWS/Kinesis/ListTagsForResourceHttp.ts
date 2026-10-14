import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostAccess from "../HostAccess.ts";
import {
  ListTagsForResource,
  type ListTagsForResourceRequest,
  type TaggableResource,
} from "./ListTagsForResource.ts";

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  Effect.gen(function* () {
    const listTagsForResource = yield* HostAccess.withCredentials(Kinesis.listTagsForResource);

    return Effect.fn(function* (resource: TaggableResource) {
      const ResourceARN = yield* getResourceArn(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* HostAccess.bind`AWS.Kinesis.ListTagsForResource(${resource})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["kinesis:ListTagsForResource"],
              Resource: [getResourceArn(resource)],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Kinesis.ListTagsForResource(${resource.LogicalId})`)(function* (
        request?: ListTagsForResourceRequest,
      ) {
        return yield* listTagsForResource({
          ...request,
          ResourceARN: yield* ResourceARN,
        });
      });
    });
  }),
);

const getResourceArn = (resource: TaggableResource) =>
  "consumerArn" in resource ? resource.consumerArn : resource.streamArn;
