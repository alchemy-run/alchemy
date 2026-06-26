import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";
import { TagResource, type TagResourceRequest } from "./TagResource.ts";

export const TagResourceHttp = Layer.effect(
  TagResource,
  Effect.gen(function* () {
    const tagResource = yield* sns.tagResource;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.TagResource(${topic}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:TagResource"],
                Resource: [topic.topicArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SNS.TagResource(${topic.LogicalId})`)(function* (
        request: TagResourceRequest,
      ) {
        return yield* tagResource({
          ...request,
          ResourceArn: yield* TopicArn,
        });
      });
    });
  }),
);
