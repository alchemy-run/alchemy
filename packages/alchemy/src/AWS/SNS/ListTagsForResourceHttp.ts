import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListTagsForResource,
  type ListTagsForResourceRequest,
} from "./ListTagsForResource.ts";
import type { Topic } from "./Topic.ts";

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  Effect.gen(function* () {
    const listTagsForResource = yield* sns.listTagsForResource;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.ListTagsForResource(${topic}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sns:ListTagsForResource"],
                  Resource: [topic.topicArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SNS.ListTagsForResource(${topic.LogicalId})`)(
        function* (request?: ListTagsForResourceRequest) {
          return yield* listTagsForResource({
            ...request,
            ResourceArn: yield* TopicArn,
          });
        },
      );
    });
  }),
);
